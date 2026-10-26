use std::{
    fs::File,
    io::{self, Read, Write},
    path::Path,
};

pub fn compressed(file: &str) -> bool {
    let file = file.to_ascii_lowercase();
    file.ends_with(".jsonl.zst")
}

pub fn reader(file: &str, size: u64) -> io::Result<Box<dyn Read>> {
    let input = File::open(file)?;
    if input.metadata()?.len() != size {
        return Err(io::Error::other("rollout storage changed before decoding"));
    }
    if compressed(file) {
        let mut decoder = zstd::stream::read::Decoder::new(input.take(size))?;
        // Archive level-3 frames fit this window; reject unbounded decoder windows.
        decoder.window_log_max(27)?;
        Ok(Box::new(decoder))
    } else {
        Ok(Box::new(input.take(size)))
    }
}

/// A cloud transition may leave both names; only compatible JSONL prefixes are readable.
pub fn select_jsonl_source(file: &str) -> io::Result<String> {
    let plain = file.strip_suffix(".zst").unwrap_or(file);
    let encoded = format!("{plain}.zst");
    if !Path::new(&encoded).exists() {
        return Ok(plain.into());
    }
    if !Path::new(plain).exists() {
        return Ok(encoded);
    }
    let mut a = reader(plain, std::fs::metadata(plain)?.len())?;
    let mut b = reader(&encoded, std::fs::metadata(&encoded)?.len())?;
    let mut left = [0u8; 65536];
    let mut right = [0u8; 65536];
    // Read exact blocks: a decoder is allowed to return shorter reads than a regular file.
    fn block(input: &mut dyn Read, buffer: &mut [u8]) -> io::Result<usize> {
        let mut n = 0;
        while n < buffer.len() {
            let read = input.read(&mut buffer[n..])?;
            if read == 0 {
                break;
            }
            n += read;
        }
        Ok(n)
    }
    loop {
        let x = block(&mut *a, &mut left)?;
        let y = block(&mut *b, &mut right)?;
        if left[..x.min(y)] != right[..x.min(y)] {
            return Err(io::Error::other(
                "Conflicting archive source representations",
            ));
        }
        if x < left.len() || y < right.len() {
            return Ok(if x >= y { plain.into() } else { encoded });
        }
    }
}

pub fn decode(source: &str, destination: &Path) -> io::Result<()> {
    let mut input = reader(source, std::fs::metadata(source)?.len())?;
    let mut output = File::options()
        .write(true)
        .create_new(true)
        .open(destination)?;
    io::copy(&mut input, &mut output)?;
    output.flush()?;
    output.sync_all()
}

pub fn encode(source: &str, destination: &Path) -> io::Result<()> {
    let input = File::open(source)?;
    let size = input.metadata()?.len();
    let output = File::options()
        .write(true)
        .create_new(true)
        .open(destination)?;
    let mut encoder = zstd::stream::write::Encoder::new(output, 3)?;
    encoder.include_checksum(true)?;
    encoder.set_pledged_src_size(Some(size))?;
    io::copy(&mut input.take(size), &mut encoder)?;
    let mut output = encoder.finish()?;
    output.flush()?;
    output.sync_all()
}
