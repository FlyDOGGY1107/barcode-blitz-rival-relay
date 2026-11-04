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

## Anonymous demo feedback (demo v1.6+)

The game's Feedback Terminal can send four multiple-choice answers
(scanner feel, pacing, clarity, bugs) plus the demo version. No names,
Steam IDs, free text or save data are accepted, and IP addresses are only
hashed in memory for a short rate limit (3 sends per network per hour).

- `POST /api/v1/feedback` – used by the game.
- `GET /feedback` – private results page with vote bar charts. It asks for the
  admin key and then calls `GET /api/v1/feedback/summary`.

### One-time setup (owner)

1. Create a free project at supabase.com.
2. In the Supabase SQL Editor, run `feedback_table.sql` from this repository.
3. In Supabase: Project Settings > API. Copy the Project URL and the
   `service_role` key.
4. In Render: the relay service > Environment > add
   - `SUPABASE_URL` = the Project URL
   - `SUPABASE_SERVICE_KEY` = the `service_role` key
   - `FEEDBACK_ADMIN_KEY` = a long random password you make up (12+ characters)
5. Save. Render redeploys. Open `https://<your-relay>.onrender.com/feedback`
   and enter the admin key.

Never commit these values. Without the Supabase variables the relay still
accepts feedback but keeps it in memory only (lost when the free service
sleeps or restarts). Without `FEEDBACK_ADMIN_KEY` the results page is off.

An emailed digest can be added later once a Gmail address and app password
exist; they would also go into Render's environment, not this repository.

### Test

```
npm install
npm test
```
