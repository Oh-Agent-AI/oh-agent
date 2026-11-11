//! 流式 JSONL 行读取（Codex rollout）。
//!
//! 背景（2026-11-11 内存事故）：`usage_fact` 与 `workflow` 两条路径都曾
//! `std::fs::read()` 整份 rollout，再 `parse_codex_session_log` 把每一行解析成
//! `serde_json::Value`。一份 2 GB、81k 行（最大单行 25.7 MB）的活跃 rollout 被
//! 每 30–60 秒重读一次，单轮 high-water 到 16 GB，主进程被换出到 swap。
//!
//! 本模块只做一件事：把字节流按 JSONL 行切开，**内存上限 = 单行上限 + 读缓冲**，
//! 不随文件大小增长。切分语义必须与旧 `raw_line_segments` 逐字节一致：
//! 只认 `\n` / `\r\n` / `\r`，末段无换行也消费，空行保留（调用方自己 trim）。
//! 偏移是字节流里的行首位置——`source_event_id` 依赖它，不能丢。
//!
//! 单行超过 `max_line` 时不交给调用方（避免一次 `serde_json` 把整个进程顶爆），
//! 只记 `oversized`；调用方把它当「该文件本轮不可解析」降级，而不是猜半行。

use std::io::{self, BufRead, BufReader, Read};

/// 默认单行上限：64 MiB。实测最大单行 25.7 MB（Codex 的 base64/大 payload），
/// 留 2.5× 余量；再大就是异常文件，宁可按行降级也不整份重试。
pub const DEFAULT_MAX_LINE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct LineStats {
    /// 已切出的行数（含空行，未含被跳过的超限行）。
    pub lines: u64,
    /// 读入的字节数（= 最后一行末尾的绝对偏移）。
    pub bytes: u64,
    /// 超限被跳过的行数（>0 时调用方应把该文件当不可解析）。
    pub oversized: u64,
    /// 最后一个行分隔符之后的绝对偏移（= 可安全续读的位置）。文件以无换行的
    /// 残行结尾时它小于 `bytes`：续读必须从残行行首重来，否则会把「写了一半
    /// 的行」永久跳过。
    pub complete_bytes: u64,
}

/// 逐行读取 `reader`，对每一行调用 `on_line(行首偏移, 行字节)`。
///
/// `on_line` 返回 `false` 时提前停止（用于「一坏行即整份降级」的快速退出——
/// 旧语义是整份零事件，提前退出既保住语义又不用读完剩下的 GB）。
pub fn for_each_line<R: Read>(
    reader: R,
    max_line: usize,
    on_line: impl FnMut(u64, &[u8]) -> bool,
) -> io::Result<LineStats> {
    for_each_line_from(reader, 0, max_line, on_line)
}

/// 同 [`for_each_line`]，但把 `base_offset` 作为流首字节的绝对偏移。
///
/// 增量续读用：`File::seek(offset)` 之后传 `offset`，回调拿到的仍是**整个文件**
/// 的绝对行首偏移——`source_event_id` 的命名空间因此跨轮稳定，续读与全量读
/// 对同一行产出同一个 fact_id。
pub fn for_each_line_from<R: Read>(
    mut reader: R,
    base_offset: u64,
    max_line: usize,
    mut on_line: impl FnMut(u64, &[u8]) -> bool,
) -> io::Result<LineStats> {
    let mut buf = [0u8; 64 * 1024];
    let mut filled = 0usize;
    let mut cursor = 0usize;
    let mut line: Vec<u8> = Vec::new();
    let mut line_start: u64 = base_offset;
    let mut abs: u64 = base_offset;
    let mut skip_lf = false;
    let mut too_long = false;
    let mut stats = LineStats { complete_bytes: base_offset, ..LineStats::default() };

    loop {
        if cursor >= filled {
            filled = loop {
                match reader.read(&mut buf) {
                    Ok(0) => break 0,
                    Ok(n) => break n,
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) => return Err(error),
                }
            };
            cursor = 0;
            if filled == 0 {
                break;
            }
        }
        let byte = buf[cursor];
        cursor += 1;

        if skip_lf {
            skip_lf = false;
            // `\r\n` 是一个分隔符：上一块末尾的 `\r` 已经切过行，这里把 `\n`
            // 静默吃掉，否则会多出一条空行、后续偏移整体错位。
            if byte == b'\n' {
                abs += 1;
                line_start = abs;
                continue;
            }
        }

        match byte {
            b'\n' | b'\r' => {
                if too_long {
                    stats.oversized += 1;
                    too_long = false;
                } else {
                    stats.lines += 1;
                    let keep_going = on_line(line_start, &line);
                    line.clear();
                    if !keep_going {
                        stats.bytes = abs + 1;
                        stats.complete_bytes = abs + 1;
                        return Ok(stats);
                    }
                }
                line.clear();
                abs += 1;
                line_start = abs;
                stats.complete_bytes = abs;
                if byte == b'\r' {
                    skip_lf = true;
                }
            }
            _ => {
                if !too_long {
                    if line.len() >= max_line {
                        // 丢掉半行并继续扫到下一个分隔符；不把半行交给解析器。
                        too_long = true;
                        line.clear();
                    } else {
                        line.push(byte);
                    }
                }
                abs += 1;
            }
        }
    }

    if too_long {
        stats.oversized += 1;
    } else if !line.is_empty() {
        // 末段无换行也消费；纯空尾段不产生行（与 raw_line_segments 的
        // `start < data.len()` 条件一致）。
        stats.lines += 1;
        on_line(line_start, &line);
    }
    stats.bytes = abs;
    Ok(stats)
}

/// Codex `.jsonl.zst` 的多帧流式读取器：逐帧解压、逐行喂给 [`for_each_line`]，
/// 内存上限 = 一帧的解压缓冲（`ruzstd` 以固定窗口流式产出），不再把整份解压
/// 到 `Vec<u8>`。帧边界由 `into_inner` 回收底层 reader 判断，空输入 = 正常 EOF。
pub struct MultiFrameZstdReader<R: Read> {
    decoder: Option<ruzstd::decoding::StreamingDecoder<BufReader<R>, ruzstd::decoding::FrameDecoder>>,
    done: bool,
}

impl<R: Read> MultiFrameZstdReader<R> {
    pub fn new(reader: R) -> io::Result<Self> {
        let mut buffered = BufReader::new(reader);
        if buffered.fill_buf()?.is_empty() {
            return Ok(Self { decoder: None, done: true });
        }
        let decoder = ruzstd::decoding::StreamingDecoder::new(buffered)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;
        Ok(Self { decoder: Some(decoder), done: false })
    }
}

impl<R: Read> Read for MultiFrameZstdReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        loop {
            if self.done {
                return Ok(0);
            }
            if self.decoder.is_none() {
                return Ok(0);
            }
            match self.decoder.as_mut().unwrap().read(buf) {
                Ok(0) => {
                    // 当前帧结束：回收 reader，还有下一帧就继续，否则 EOF。
                    let decoder = self.decoder.take().unwrap();
                    let mut reader = decoder.into_inner();
                    if reader.fill_buf()?.is_empty() {
                        self.done = true;
                        return Ok(0);
                    }
                    self.decoder = Some(
                        ruzstd::decoding::StreamingDecoder::new(reader).map_err(|error| {
                            io::Error::new(io::ErrorKind::InvalidData, error.to_string())
                        })?,
                    );
                }
                Ok(n) => return Ok(n),
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => {
                    self.done = true;
                    return Err(error);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(text: &[u8]) -> Vec<(u64, String)> {
        let mut out = Vec::new();
        for_each_line(text, DEFAULT_MAX_LINE_BYTES, |offset, line| {
            out.push((offset, String::from_utf8_lossy(line).into_owned()));
            true
        })
        .unwrap();
        out
    }

    #[test]
    fn splits_lf_crlf_and_lone_cr_with_absolute_offsets() {
        assert_eq!(
            lines(b"a\nb\r\nc\rd"),
            vec![
                (0, "a".into()),
                (2, "b".into()),
                (5, "c".into()),
                (7, "d".into()),
            ]
        );
    }

    #[test]
    fn trailing_newline_does_not_emit_an_empty_tail_but_inner_blanks_do() {
        assert_eq!(lines(b"a\n"), vec![(0, "a".into())]);
        assert_eq!(
            lines(b"a\n\nb\n"),
            vec![(0, "a".into()), (2, "".into()), (3, "b".into())]
        );
    }

    #[test]
    fn crlf_split_across_the_read_buffer_keeps_offsets() {
        // 构造一条刚好跨 64 KiB 读缓冲边界的行，确认 `\r` / `\n` 分块不会多出一行。
        let mut text = vec![b'x'; 64 * 1024 - 1];
        text.extend_from_slice(b"\r\nnext\n");
        let out = lines(&text);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].0, 0);
        assert_eq!(out[1].0, (64 * 1024 + 1) as u64);
        assert_eq!(out[1].1, "next");
    }

    #[test]
    fn oversized_line_is_skipped_and_counted_without_losing_later_offsets() {
        let mut text = vec![b'a'; 32];
        text.extend_from_slice(b"\n");
        let mut seen = Vec::new();
        let stats = for_each_line(&text[..], 16, |offset, line| {
            seen.push((offset, line.len()));
            true
        })
        .unwrap();
        assert_eq!(stats.oversized, 1);
        assert!(seen.is_empty());
        assert_eq!(stats.bytes, 33);
    }

    #[test]
    fn caller_can_stop_early_on_first_bad_line() {
        let text = b"ok\nbad\nmore\n";
        let mut seen = 0;
        let stats = for_each_line(&text[..], DEFAULT_MAX_LINE_BYTES, |_, line| {
            seen += 1;
            line != b"bad"
        })
        .unwrap();
        assert_eq!(seen, 2);
        assert_eq!(stats.bytes, 7);
    }
}
