# NhacCuaTao

A small personal music app split into frontend and backend layers.

## Structure

- `frontend/`: browser UI and static assets
- `backend/`: music API and file management
- `run_all.py`: launches both backend and frontend together
- `docker-compose.yml`: one-command multi-container startup

## Run locally

### Option 1: Python launcher

```bash
python -m pip install -r backend/requirements.txt
python run_all.py
```

Then open:

- Frontend: http://localhost:8080
- Backend API: http://localhost:5000/api/health

### Option 3: Windows LAN test

Run `local_network_run.bat` from the project root. It prints the host's LAN IPv4
address and opens backend/frontend in separate terminal windows. On another
device connected to the same Wi-Fi, open `http://<LAN-IP>:8080`; the frontend
will select the matching API host on port `5000` automatically.

If Windows Firewall blocks access, set the network profile to **Private**, then
open **Windows Defender Firewall with Advanced Security > Inbound Rules > New
Rule > Port > TCP**. Allow local ports `5000,8080` for the **Private** profile
only. On iPhone, join the same Wi-Fi and open `http://<LAN-IP>:8080` in Safari.
Check `http://<LAN-IP>:5000/api/health` if the page loads but the library does
not. Do not expose these unauthenticated LAN-test ports to public networks.

### Option 2: Docker Compose

```bash
docker compose up --build
```

Then open:

- Frontend: http://localhost:8080
- Backend API: http://localhost:5000/api/health

## Frontend API configuration

The frontend no longer hardcodes localhost in the app logic. Set the backend base URL in [frontend/config.js](frontend/config.js) or copy [frontend/config.example.js](frontend/config.example.js) and update it for your environment.

Example:

```javascript
window.__APP_CONFIG__ = window.__APP_CONFIG__ || {};
window.__APP_CONFIG__.apiBase = `${window.location.protocol}//${window.location.hostname}:5000/api`;
```

## Music library folder

The backend scans the local library folder at `backend/storage/library` by default. Put music files there, or override it with the `MUSIC_ROOT` environment variable.

## API endpoints

- `GET /api/health`
- `GET /api/songs`
- `GET /api/scan`
- `GET /api/artists`
- `GET /api/quality/<track_id>`
- `GET /api/stream/<song_id>`
- `POST /api/upload`
- `GET|POST /api/requests`
- `GET|POST /api/playlists`
- `POST /api/playlists/<id>/tracks`
- `PUT|DELETE /api/playlists/<id>`
- `DELETE /api/playlists/<id>/tracks/<track_id>`
- `GET|POST|DELETE /api/favorites`

## Notes

Uploaded music files are stored in `backend/storage/uploads`.

Requests, playlists, and favorites are stored as UTF-8 JSON arrays in
`backend/storage/data/requests.json`, `playlists.json`, and `favorites.json`.
Playlist reordering uses `PUT /api/playlists/<id>` with a `track_ids` array.

ALAC `.m4a` playback is transcoded on the fly to FLAC. The backend uses a system
`ffmpeg` from `PATH` when available, otherwise it uses the bundled executable
from `imageio-ffmpeg`. If neither is available, the stream endpoint logs a clear
warning and returns `503`. Because the transcoded stream has no known byte length,
seeking is unavailable for ALAC playback; FLAC, MP3, and WAV keep direct Range
streaming from their original files.
