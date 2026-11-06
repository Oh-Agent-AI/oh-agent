use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use tokio_websockets::{ClientBuilder, Message};

#[derive(Clone)]
pub struct RelayConnection {
    pub relay: String,
    pub room_id: String,
    pub owner_token: String,
}

impl RelayConnection {
    pub fn endpoint(&self, operation: &str) -> String {
        format!("{}/v1/rooms/{}/{operation}", self.relay.trim_end_matches('/'), self.room_id)
    }

    pub fn ws_endpoint(&self, ticket: &str) -> Result<String, &'static str> {
        let mut url = reqwest::Url::parse(&self.endpoint("ws")).map_err(|_| "remote_url_invalid")?;
        url.set_scheme("wss").map_err(|_| "remote_url_invalid")?;
        url.query_pairs_mut().append_pair("ticket", ticket);
        Ok(url.into())
    }

    pub async fn post(&self, operation: &str, body: Value) -> Result<Value, &'static str> {
        let response = reqwest::Client::new().post(self.endpoint(operation))
            .bearer_auth(&self.owner_token).json(&body).timeout(Duration::from_secs(10))
            .send().await.map_err(|_| "remote_unavailable")?;
        if !response.status().is_success() { return Err("remote_unavailable"); }
        response.json().await.map_err(|_| "remote_unavailable")
    }

    async fn ticket(&self) -> Result<String, &'static str> {
        let value = self.post("access", json!({"action":"pair","role":"host"})).await?;
        value["ticket"].as_str().map(str::to_owned).ok_or("remote_unavailable")
    }
}

pub async fn run(
    relay: RelayConnection,
    mut outgoing: mpsc::Receiver<String>,
    mut cancel: watch::Receiver<bool>,
    on_message: impl Fn(Value) + Send,
    on_status: impl Fn(&str) + Send,
) {
    let mut delay = 1_u64;
    loop {
        if *cancel.borrow() { break; }
        let ticket = tokio::select! {
            changed = cancel.changed() => { if changed.is_err() || *cancel.borrow() { break; } else { continue; } }
            result = relay.ticket() => match result { Ok(ticket) => ticket, Err(_) => { tokio::time::sleep(Duration::from_secs(delay)).await; delay = (delay * 2).min(15); continue; } }
        };
        let uri = match relay.ws_endpoint(&ticket).and_then(|url| url.parse().map_err(|_| "remote_url_invalid")) {
            Ok(uri) => uri,
            Err(_) => break,
        };
        let builder = ClientBuilder::from_uri(uri);
        let connection = builder.connect();
        let connection = tokio::select! {
            changed = cancel.changed() => { if changed.is_err() || *cancel.borrow() { break; } else { continue; } }
            result = connection => result
        };
        let Ok((socket, _)) = connection else {
            on_status("offline");
            tokio::time::sleep(Duration::from_secs(delay)).await;
            delay = (delay * 2).min(15);
            continue;
        };
        delay = 1;
        on_status("online");
        let (mut sink, mut incoming) = socket.split();
        let stopped = loop {
            tokio::select! {
                changed = cancel.changed() => { if changed.is_err() || *cancel.borrow() { break true; } }
                outbound = outgoing.recv() => {
                    let Some(text) = outbound else { break true; };
                    if sink.send(Message::text(text)).await.is_err() { break false; }
                }
                inbound = incoming.next() => {
                    let Some(Ok(message)) = inbound else { break false; };
                    if message.is_ping() { let _ = sink.send(Message::pong(message.into_payload())).await; continue; }
                    if !message.is_text() { continue; }
                    let text = message.as_text().unwrap_or_default();
                    if text.len() > 256 * 1024 { continue; }
                    if let Ok(value) = serde_json::from_str::<Value>(text) { on_message(value); }
                }
            }
        };
        if stopped { break; }
        on_status("offline");
    }
    on_status("closed");
}
