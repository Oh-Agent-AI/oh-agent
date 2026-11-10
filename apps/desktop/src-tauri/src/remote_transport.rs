use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use tokio_websockets::{ClientBuilder, Message};

#[derive(Clone)]
pub struct RelayConnection {
    pub relay: String,
    pub room_id: String,
    pub owner_token: String,
    http_client: reqwest::Client,
}

#[derive(Debug, PartialEq, Eq)]
pub struct OwnerPairing {
    pub ticket: String,
    pub device_id: String,
    pub reconnect_token: String,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Invitation {
    pub id: String,
    pub secret: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingResponse {
    ticket: String,
    device_id: String,
    reconnect_token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InvitationResponse {
    invite_id: String,
    invite_secret: String,
}

pub fn valid_relay_url(value: &str) -> bool {
    reqwest::Url::parse(value).ok().is_some_and(|url| url.scheme() == "https" && url.host_str().is_some() && url.username().is_empty() && url.password().is_none())
}

impl RelayConnection {
    pub fn new(relay: String, room_id: String, owner_token: String) -> Self {
        Self { relay, room_id, owner_token, http_client: reqwest::Client::new() }
    }

    #[cfg(test)]
    fn with_http_client(relay: String, room_id: String, owner_token: String, http_client: reqwest::Client) -> Self {
        Self { relay, room_id, owner_token, http_client }
    }

    pub fn endpoint(&self, operation: &str) -> String {
        format!("{}/v1/rooms/{}/{operation}", self.relay.trim_end_matches('/'), self.room_id)
    }

    pub fn access_endpoint(&self) -> String { self.endpoint("access") }

    pub fn ws_endpoint(&self, ticket: &str) -> Result<String, &'static str> {
        let mut url = reqwest::Url::parse(&self.endpoint("ws")).map_err(|_| "remote_url_invalid")?;
        url.set_scheme("wss").map_err(|_| "remote_url_invalid")?;
        url.query_pairs_mut().append_pair("ticket", ticket);
        Ok(url.into())
    }

    async fn post(&self, operation: &str, body: Value) -> Result<Value, &'static str> {
        let response = self.http_client.post(self.endpoint(operation))
            .bearer_auth(&self.owner_token).json(&body).timeout(Duration::from_secs(10))
            .send().await.map_err(|_| "remote_unavailable")?;
        if !response.status().is_success() { return Err("remote_unavailable"); }
        response.json().await.map_err(|_| "remote_unavailable")
    }

    pub async fn register(&self, app_id: &str, session_id: &str, capability: &crate::remote_protocol::RemoteCapability, owner_token: &str) -> Result<(), &'static str> {
        self.post("register", json!({"protocol":crate::remote_protocol::PROTOCOL,"appId":app_id,"sessionId":session_id,"capability":capability,"ownerToken":owner_token})).await?;
        Ok(())
    }

    pub async fn pair_owner(&self) -> Result<OwnerPairing, &'static str> {
        let response: PairingResponse = serde_json::from_value(self.post("access", json!({"action":"pair","role":"owner"})).await?).map_err(|_| "remote_unavailable")?;
        Ok(OwnerPairing { ticket: response.ticket, device_id: response.device_id, reconnect_token: response.reconnect_token })
    }

    pub async fn invite(&self) -> Result<Invitation, &'static str> {
        let response: InvitationResponse = serde_json::from_value(self.post("access", json!({"action":"invite"})).await?).map_err(|_| "remote_unavailable")?;
        Ok(Invitation { id: response.invite_id, secret: response.invite_secret })
    }

    pub async fn pending_devices(&self) -> Result<Value, &'static str> {
        self.post("access", json!({"action":"pending"})).await
    }

    pub async fn set_device_access(&self, action: &str, device_id: &str) -> Result<Value, &'static str> {
        if !matches!(action, "approve" | "revoke") { return Err("invalid_request"); }
        self.post("access", json!({"action":action,"deviceId":device_id})).await
    }

    pub async fn close(&self) -> Result<(), &'static str> {
        self.post("close", json!({})).await?;
        Ok(())
    }

    async fn host_ticket(&self) -> Result<String, &'static str> {
        let value = self.post("access", json!({"action":"pair","role":"host"})).await?;
        value["ticket"].as_str().map(str::to_owned).ok_or("remote_unavailable")
    }
}

async fn wait_backoff_or_cancel(cancel: &mut watch::Receiver<bool>, delay_seconds: u64) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(Duration::from_secs(delay_seconds)) => false,
        changed = cancel.changed() => changed.is_err() || *cancel.borrow(),
    }
}

fn discard_queued(outgoing: &mut mpsc::Receiver<String>) {
    while outgoing.try_recv().is_ok() {}
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
            result = relay.host_ticket() => match result {
                Ok(ticket) => ticket,
                Err(_) => {
                    if wait_backoff_or_cancel(&mut cancel, delay).await { break; }
                    delay = (delay * 2).min(15);
                    continue;
                }
            }
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
            discard_queued(&mut outgoing);
            if wait_backoff_or_cancel(&mut cancel, delay).await { break; }
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
        discard_queued(&mut outgoing);
    }
    on_status("closed");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    fn mock_http(response_body: &'static str) -> (String, std::thread::JoinHandle<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 2048];
            loop {
                let count = stream.read(&mut buffer).unwrap();
                if count == 0 { break; }
                request.extend_from_slice(&buffer[..count]);
                if let Some(headers_end) = request.windows(4).position(|window| window == b"\r\n\r\n").map(|index| index + 4) {
                    let headers = String::from_utf8_lossy(&request[..headers_end]);
                    let body_length = headers.lines().find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().ok()).flatten()
                    }).unwrap_or(0);
                    if request.len() >= headers_end + body_length { break; }
                }
            }
            let body = response_body.to_string();
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            String::from_utf8(request).unwrap()
        });
        (format!("http://{address}"), worker)
    }

    #[test]
    fn relay_access_responses_require_the_fields_used_to_build_links() {
        let pair: PairingResponse = serde_json::from_value(json!({"ticket":"ticket","deviceId":"device","reconnectToken":"reconnect"})).unwrap();
        assert_eq!(pair.device_id, "device");
        assert!(serde_json::from_value::<PairingResponse>(json!({"ticket":"ticket","deviceId":"device"})).is_err());
        let invitation: InvitationResponse = serde_json::from_value(json!({"inviteId":"invite","inviteSecret":"secret"})).unwrap();
        assert_eq!(invitation.invite_id, "invite");
        assert!(serde_json::from_value::<InvitationResponse>(json!({"inviteId":"invite"})).is_err());
    }

    #[tokio::test]
    async fn device_access_api_rejects_unknown_actions_before_network_io() {
        let relay = RelayConnection::new("http://127.0.0.1:1".into(), "room".into(), "secret".into());
        assert_eq!(relay.set_device_access("grant-all", "device").await, Err("invalid_request"));
    }

    #[tokio::test]
    async fn owner_pairing_uses_generic_access_endpoint_and_typed_response() {
        let (relay_url, worker) = mock_http(r#"{"ticket":"owner-ticket","deviceId":"device-1","reconnectToken":"reconnect-1"}"#);
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let relay = RelayConnection::with_http_client(relay_url, "room-1".into(), "owner-token".into(), client);
        let result = relay.pair_owner().await;
        let request = worker.join().unwrap();
        let pair = result.unwrap_or_else(|error| panic!("pair request failed: {error}; request: {request}"));
        assert!(request.starts_with("POST /v1/rooms/room-1/access HTTP/1.1"));
        assert!(request.to_ascii_lowercase().contains("authorization: bearer owner-token"));
        assert!(request.contains(r#"{"action":"pair","role":"owner"}"#));
        assert_eq!(pair, OwnerPairing { ticket: "owner-ticket".into(), device_id: "device-1".into(), reconnect_token: "reconnect-1".into() });
    }

    #[tokio::test]
    async fn reconnect_backoff_is_interruptible_by_session_cancel() {
        let (cancel, mut receiver) = watch::channel(false);
        let wait = tokio::spawn(async move { wait_backoff_or_cancel(&mut receiver, 60).await });
        tokio::time::sleep(Duration::from_millis(5)).await;
        cancel.send_replace(true);
        assert!(tokio::time::timeout(Duration::from_millis(100), wait).await.unwrap().unwrap());
    }

    #[test]
    fn disconnect_discards_queued_replies_before_reconnect() {
        let (sender, mut receiver) = mpsc::channel(4);
        sender.try_send("stale-response".into()).unwrap();
        sender.try_send("stale-event".into()).unwrap();
        discard_queued(&mut receiver);
        assert!(receiver.try_recv().is_err());
    }
}
