use indicatif::{ProgressBar, ProgressStyle};
use std::time::Instant;

/// Create a styled progress bar for file transfer.
pub fn create_progress_bar(total_bytes: u64) -> ProgressBar {
    let pb = ProgressBar::new(total_bytes);
    pb.set_style(
        ProgressStyle::with_template(
            "{spinner:.cyan} [{elapsed_precise}] [{wide_bar:.cyan/blue}] {bytes}/{total_bytes} ({bytes_per_sec}) ETA: {eta}",
        )
        .unwrap()
        .progress_chars("##-"),
    );
    pb
}

/// Print transfer summary after completion.
pub fn print_summary(file_name: &str, file_size: u64, start: Instant) {
    let elapsed = start.elapsed();
    let secs = elapsed.as_secs_f64();
    let speed = file_size as f64 / secs;

    println!();
    println!("  Transfer complete!");
    println!("  File:     {}", file_name);
    println!("  Size:     {}", format_bytes(file_size));
    println!("  Time:     {:.2}s", secs);
    println!("  Speed:    {}/s", format_bytes(speed as u64));
    println!("  Streams:  {}", crate::protocol::NUM_STREAMS);
}

/// Format bytes to human-readable string.
pub fn format_bytes(bytes: u64) -> String {
    const UNITS: &[&str] = &["B", "KB", "MB", "GB", "TB"];
    if bytes == 0 {
        return "0 B".to_string();
    }
    let exp = (bytes as f64).log(1024.0).floor() as usize;
    let exp = exp.min(UNITS.len() - 1);
    let value = bytes as f64 / 1024f64.powi(exp as i32);
    format!("{:.2} {}", value, UNITS[exp])
}
