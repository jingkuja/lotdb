//! Reading import files: decoding from the file's encoding (UTF-8, GBK, …)
//! and a CSV reader that keeps a quoted empty field (`""`) apart from a bare
//! empty one, so files written by our own CSV export round-trip NULLs.

use encoding_rs::{DecoderResult, Encoding};
use serde::Deserialize;
use std::io::{self, Read};

/// Resolve an encoding label ("utf-8", "gbk", "gb18030", "big5", …).
pub fn encoding_for(label: &str) -> Result<&'static Encoding, String> {
    let label = if label.trim().is_empty() {
        "utf-8"
    } else {
        label
    };
    Encoding::for_label(label.trim().as_bytes()).ok_or_else(|| format!("不支持的文件编码: {label}"))
}

/// A `Read` yielding UTF-8, decoded from `encoding` as it streams. A byte
/// order mark at the start wins over `encoding` and is dropped. Malformed
/// input is an error rather than silently replaced, since a wrong encoding
/// choice would otherwise corrupt every imported value.
pub struct DecodeReader<R> {
    inner: R,
    decoder: encoding_rs::Decoder,
    raw: Vec<u8>,
    out: Vec<u8>,
    pos: usize,
    done: bool,
}

impl<R: Read> DecodeReader<R> {
    pub fn new(inner: R, encoding: &'static Encoding) -> Self {
        DecodeReader {
            inner,
            decoder: encoding.new_decoder(),
            raw: vec![0; 64 * 1024],
            out: Vec::new(),
            pos: 0,
            done: false,
        }
    }

    fn fill(&mut self) -> io::Result<()> {
        self.out.clear();
        self.pos = 0;
        while self.out.is_empty() && !self.done {
            let n = self.inner.read(&mut self.raw)?;
            let last = n == 0;
            let mut input = &self.raw[..n];
            loop {
                let room = self
                    .decoder
                    .max_utf8_buffer_length_without_replacement(input.len())
                    .unwrap_or(input.len() * 4 + 16);
                let start = self.out.len();
                self.out.resize(start + room, 0);
                let (result, read, written) = self.decoder.decode_to_utf8_without_replacement(
                    input,
                    &mut self.out[start..],
                    last,
                );
                self.out.truncate(start + written);
                input = &input[read..];
                match result {
                    DecoderResult::InputEmpty => break,
                    DecoderResult::OutputFull => continue,
                    DecoderResult::Malformed(..) => {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            format!(
                                "文件内容不是有效的 {} 编码，请选择正确的文件编码",
                                self.decoder.encoding().name()
                            ),
                        ))
                    }
                }
            }
            self.done = last;
        }
        Ok(())
    }
}

impl<R: Read> Read for DecodeReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.pos == self.out.len() {
            self.fill()?;
        }
        let n = buf.len().min(self.out.len() - self.pos);
        buf[..n].copy_from_slice(&self.out[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

/// Read a whole text file in `encoding`.
pub fn read_text(path: &str, encoding: &str) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut text = String::new();
    DecodeReader::new(file, encoding_for(encoding)?)
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    Ok(text)
}

/// How CSV text maps to values.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CsvOptions {
    /// Encoding label; empty = UTF-8.
    pub encoding: String,
    /// Field separator: one ASCII character, `,` by default.
    pub delimiter: String,
    /// A bare (unquoted) empty field is NULL; otherwise an empty string.
    /// A quoted `""` is always an empty string.
    pub empty_is_null: bool,
    /// Unquoted text that also means NULL, such as `\N` or `NULL`.
    pub null_text: String,
}

impl Default for CsvOptions {
    fn default() -> Self {
        CsvOptions {
            encoding: "utf-8".into(),
            delimiter: ",".into(),
            empty_is_null: true,
            null_text: String::new(),
        }
    }
}

impl CsvOptions {
    fn delimiter_byte(&self) -> Result<u8, String> {
        match self.delimiter.as_bytes() {
            [] => Ok(b','),
            [b] if b.is_ascii() && !matches!(b, b'"' | b'\r' | b'\n') => Ok(*b),
            _ => Err(format!("无效的分隔符: {}", self.delimiter)),
        }
    }

    pub fn value(&self, field: CsvField) -> Option<String> {
        if !field.quoted
            && ((field.text.is_empty() && self.empty_is_null)
                || (!self.null_text.is_empty() && field.text == self.null_text))
        {
            return None;
        }
        Some(field.text)
    }
}

#[derive(Debug, PartialEq)]
pub struct CsvField {
    pub text: String,
    /// The field was written in double quotes.
    pub quoted: bool,
}

/// RFC 4180 records. Blank lines are skipped; text after a closing quote is
/// kept (as most readers do) instead of failing the whole file.
pub struct CsvReader<R> {
    src: R,
    buf: Vec<u8>,
    pos: usize,
    len: usize,
    delimiter: u8,
}

pub type FileCsvReader = CsvReader<DecodeReader<std::fs::File>>;

impl FileCsvReader {
    pub fn open(path: &str, options: &CsvOptions) -> Result<Self, String> {
        let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let decoded = DecodeReader::new(file, encoding_for(&options.encoding)?);
        Ok(CsvReader::new(decoded, options.delimiter_byte()?))
    }
}

impl<R: Read> CsvReader<R> {
    pub fn new(src: R, delimiter: u8) -> Self {
        CsvReader {
            src,
            buf: vec![0; 64 * 1024],
            pos: 0,
            len: 0,
            delimiter,
        }
    }

    fn peek(&mut self) -> io::Result<Option<u8>> {
        if self.pos == self.len {
            self.len = self.src.read(&mut self.buf)?;
            self.pos = 0;
            if self.len == 0 {
                return Ok(None);
            }
        }
        Ok(Some(self.buf[self.pos]))
    }

    pub fn next_record(&mut self) -> Result<Option<Vec<CsvField>>, String> {
        self.read_record().map_err(|e| e.to_string())
    }

    fn read_record(&mut self) -> io::Result<Option<Vec<CsvField>>> {
        loop {
            if self.peek()?.is_none() {
                return Ok(None);
            }
            let record = self.read_line()?;
            let blank = matches!(record.as_slice(), [f] if f.text.is_empty() && !f.quoted);
            if !blank {
                return Ok(Some(record));
            }
        }
    }

    /// One record; the caller has checked that input remains.
    fn read_line(&mut self) -> io::Result<Vec<CsvField>> {
        let mut fields = vec![];
        let mut text = Vec::new();
        let mut quoted = false;
        let finish = |text: &mut Vec<u8>, quoted: bool| -> io::Result<CsvField> {
            // Only ASCII bytes split fields, so each is still valid UTF-8.
            let text = String::from_utf8(std::mem::take(text))
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            Ok(CsvField { text, quoted })
        };
        loop {
            match self.peek()? {
                None => {
                    fields.push(finish(&mut text, quoted)?);
                    return Ok(fields);
                }
                Some(b'"') if text.is_empty() && !quoted => {
                    self.pos += 1;
                    quoted = true;
                    loop {
                        match self.peek()? {
                            None => {
                                return Err(io::Error::new(
                                    io::ErrorKind::InvalidData,
                                    "引号未闭合，文件在字段中间结束",
                                ))
                            }
                            Some(b'"') => {
                                self.pos += 1;
                                if self.peek()? == Some(b'"') {
                                    text.push(b'"');
                                    self.pos += 1;
                                } else {
                                    break;
                                }
                            }
                            Some(c) => {
                                text.push(c);
                                self.pos += 1;
                            }
                        }
                    }
                }
                Some(c) if c == self.delimiter => {
                    self.pos += 1;
                    fields.push(finish(&mut text, quoted)?);
                    quoted = false;
                }
                Some(b'\r') => {
                    self.pos += 1;
                    if self.peek()? == Some(b'\n') {
                        self.pos += 1;
                    }
                    fields.push(finish(&mut text, quoted)?);
                    return Ok(fields);
                }
                Some(b'\n') => {
                    self.pos += 1;
                    fields.push(finish(&mut text, quoted)?);
                    return Ok(fields);
                }
                Some(c) => {
                    text.push(c);
                    self.pos += 1;
                }
            }
        }
    }
}

impl<R: Read> Iterator for CsvReader<R> {
    type Item = Result<Vec<CsvField>, String>;

    fn next(&mut self) -> Option<Self::Item> {
        self.next_record().transpose()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn records(input: &[u8], encoding: &str) -> Vec<Vec<(String, bool)>> {
        let decoded = DecodeReader::new(input, encoding_for(encoding).unwrap());
        CsvReader::new(decoded, b',')
            .map(|r| r.unwrap().into_iter().map(|f| (f.text, f.quoted)).collect())
            .collect()
    }

    #[test]
    fn keeps_quoted_empty_apart_from_bare_empty() {
        let rows = records(b"a,\"\",,\"x\"\"y\"\r\n\n\"multi\nline\",2", "utf-8");
        assert_eq!(
            rows,
            vec![
                vec![
                    ("a".into(), false),
                    ("".into(), true),
                    ("".into(), false),
                    ("x\"y".into(), true)
                ],
                vec![("multi\nline".into(), true), ("2".into(), false)],
            ]
        );
        let opts = CsvOptions {
            null_text: "\\N".into(),
            ..Default::default()
        };
        let field = |text: &str, quoted| CsvField {
            text: text.into(),
            quoted,
        };
        assert_eq!(opts.value(field("", false)), None);
        assert_eq!(opts.value(field("", true)), Some(String::new()));
        assert_eq!(opts.value(field("\\N", false)), None);
        assert_eq!(opts.value(field("\\N", true)), Some("\\N".into()));
        let keep_empty = CsvOptions {
            empty_is_null: false,
            ..Default::default()
        };
        assert_eq!(keep_empty.value(field("", false)), Some(String::new()));
    }

    #[test]
    fn decodes_gbk_and_strips_bom() {
        // "名称,值\n张三,1" in GBK
        let (gbk, _, _) = encoding_rs::GBK.encode("名称,值\n张三,1");
        let rows = records(&gbk, "gbk");
        assert_eq!(rows[1][0], ("张三".into(), false));
        let rows = records("\u{feff}id\n1".as_bytes(), "gbk");
        assert_eq!(
            rows[0][0].0, "id",
            "a UTF-8 BOM overrides the chosen encoding"
        );
        let decoded = DecodeReader::new(&gbk[..], encoding_for("utf-8").unwrap());
        let err = CsvReader::new(decoded, b',').next().unwrap().unwrap_err();
        assert!(err.contains("UTF-8"), "{err}");
    }

    #[test]
    fn unterminated_quote_is_an_error() {
        let decoded = DecodeReader::new(&b"\"abc"[..], encoding_rs::UTF_8);
        assert!(CsvReader::new(decoded, b',').next().unwrap().is_err());
    }
}
