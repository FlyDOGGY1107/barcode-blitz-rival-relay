# Barcode Blitz Rival Relay

This service replaces home-IP friend codes with short room codes. Both players
open an outbound secure WebSocket connection to the relay, so no UPnP, port
forwarding, or publicly exposed player IP address is required.

## Local test

```powershell
npm install
npm test
```

The relay listens at `ws://127.0.0.1:9080/rival` by default and exposes a health
check at `http://127.0.0.1:9080/health`.

## Render deployment

1. Put this directory in a GitHub repository.
2. In Render, create a Blueprint or Docker Web Service from the repository.
3. If this folder is inside a larger repository, set the service root directory
   to `relay_server`. The included `render.yaml` and `Dockerfile` need no secrets.
4. Copy the resulting URL and append `/rival`, for example:
   `wss://barcode-blitz-rival-relay.onrender.com/rival`.
5. Paste that one line into `relay_url.txt` beside the Barcode Blitz executable.

Render free services can sleep after inactivity, so the first connection may
take longer. Use an always-on instance before a public launch.

## Production notes

- Run one relay instance unless room state is moved to shared storage.
- The service only forwards room messages. It stores no accounts or match data.
- Room codes use a 32-character alphabet and 12 random characters.
- Connections are size-limited, rate-limited, heartbeat-checked, and expire.
- Steam builds should ultimately use Steam Datagram Relay instead.
