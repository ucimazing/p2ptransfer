mod progress;
mod protocol;
mod receiver;
mod sender;
mod signaling;

use clap::{Parser, Subcommand};

/// FastTransfer CLI — High-speed P2P file transfer.
/// Uses 8 parallel TCP streams with 1MB chunks to saturate your bandwidth.
#[derive(Parser)]
#[command(name = "fasttransfer", version, about)]
struct Cli {
    /// Signaling server URL (e.g. http://localhost:8080)
    #[arg(short, long, default_value = "http://localhost:8080")]
    server: String,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Send a file
    Send {
        /// Path to the file to send
        file: String,
    },
    /// Receive a file
    Receive {
        /// Room code from the sender
        code: String,

        /// Output directory (default: current directory)
        #[arg(short, long, default_value = ".")]
        output: String,
    },
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    println!();
    println!("  FastTransfer v{}", env!("CARGO_PKG_VERSION"));
    println!("  ─────────────────────────────");
    println!();

    let result = match cli.command {
        Commands::Send { file } => sender::send_file(&cli.server, &file).await,
        Commands::Receive { code, output } => {
            receiver::receive_file(&cli.server, &code, &output).await
        }
    };

    if let Err(e) = result {
        eprintln!("  Error: {}", e);
        std::process::exit(1);
    }

    println!();
}
