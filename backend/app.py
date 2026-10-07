import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import uuid
from datetime import datetime, timezone
from email.parser import BytesParser
from email.policy import default as email_default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

try:
    from mutagen import File as MutagenFile
except ImportError:
    MutagenFile = None

try:
    import imageio_ffmpeg
except ImportError:
    imageio_ffmpeg = None

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "storage" / "uploads"
DATA_DIR = Path(os.environ.get("APP_DATA_DIR", BASE_DIR / "storage" / "data"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
CHUNK_SIZE = 64 * 1024
DATA_COLLECTIONS = {"requests", "playlists", "favorites"}
DATA_LOCK = threading.RLock()

ALLOWED_EXTENSIONS = {".flac", ".alac", ".wav", ".mp3", ".m4a", ".aac", ".ogg", ".opus"}
AUDIO_MIME_TYPES = {
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".alac": "audio/mp4",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
}


def normalize_name(value: str) -> str:
    cleaned = (value or "").replace("_", " ").replace(".", " ")
    cleaned = cleaned.replace("—", "-").replace("–", "-")
    cleaned = re.sub(r"\[[^\]]+\]", " ", cleaned)
    cleaned = re.sub(r"\([^\)]*\)", " ", cleaned)
    cleaned = re.sub(r"\b(?:feat|ft)\.?\s*[A-Za-z0-9_.-]+", " ", cleaned, flags=re.I)
    return " ".join(cleaned.split())


def split_artists(value: str):
    if not value:
        return []
    separator = re.compile(r"\s*(?:,|&|/)\s*|\s+(?:ft\.?|feat\.?|vs\.?|x)\s+", flags=re.I)
    artists = []
    seen = set()
    for artist in separator.split(value):
        artist = artist.strip(" \t\r\n.,;&/")
        key = artist.casefold()
        if artist and key not in seen:
            artists.append(artist)
            seen.add(key)
    return artists


def load_json_collection(name: str):
    if name not in DATA_COLLECTIONS:
        raise ValueError("Unknown data collection")
    with DATA_LOCK:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        path = DATA_DIR / f"{name}.json"
        if not path.exists():
            save_json_collection(name, [])
        try:
            with path.open("r", encoding="utf-8") as data_file:
                data = json.load(data_file)
        except json.JSONDecodeError as error:
            raise ValueError(f"{path.name} contains invalid JSON") from error
        if not isinstance(data, list):
            raise ValueError(f"{path.name} must contain a JSON array")
        return data


def save_json_collection(name: str, data):
    if name not in DATA_COLLECTIONS:
        raise ValueError("Unknown data collection")
    if not isinstance(data, list):
        raise ValueError("Collection data must be a list")
    with DATA_LOCK:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        path = DATA_DIR / f"{name}.json"
        temporary_path = DATA_DIR / f".{name}.{threading.get_ident()}.tmp"
        with temporary_path.open("w", encoding="utf-8") as data_file:
            json.dump(data, data_file, ensure_ascii=False, indent=2)
            data_file.write("\n")
        os.replace(temporary_path, path)


def initialize_data_store():
    for collection in DATA_COLLECTIONS:
        load_json_collection(collection)


def clean_filename_title(file_name: str) -> str:
    raw = Path(file_name).stem
    raw = raw.replace("_", " ")
    raw = re.sub(r"(?:\s*\[[^\]]*\])+$", "", raw)
    raw = re.sub(r"^\s*(?:\d+\s*[._-]\s*|\d+\s+)+", "", raw)
    raw = re.sub(r"\[[^\]]*\]", " ", raw)
    raw = re.sub(r"\s+", " ", raw)
    return raw.strip(" -_") or Path(file_name).name


def safe_filename(name: str) -> str:
    base = os.path.basename(name or "song")
    return "".join(ch if ch.isalnum() or ch in {"-", "_", "."} else "_" for ch in base)


def build_track_id(path: Path) -> str:
    stem = path.stem
    safe = re.sub(r"[^a-zA-Z0-9_\-]+", "_", stem).strip("_")
    return safe or "track"


def extract_quality_label(path: Path) -> str:
    raw = path.stem
    format_name = path.suffix.lower().lstrip(".").upper()
    codec_match = re.search(r"\[(ALAC|FLAC|AAC|MP3|WAV|OGG|OPUS)\]", raw, flags=re.I)
    bit_match = re.search(r"(\d+)\s*bit", raw, flags=re.I)
    khz_match = re.search(r"(\d+(?:[.,]\d+)?)\s*kHz", raw, flags=re.I)
    technical_parts = []
    if bit_match:
        technical_parts.append(f"{bit_match.group(1)}-bit")
    if khz_match:
        technical_parts.append(f"{khz_match.group(1)}kHz")
    details = " / ".join(technical_parts)
    if codec_match:
        details = f"{codec_match.group(1).upper()} {details}".strip()
    if format_name:
        return f"{details} • {format_name}" if details else format_name
    return details


def read_audio_metadata(path: Path):
    if MutagenFile is None:
        return {}
    try:
        audio_file = MutagenFile(path, easy=True)
    except Exception:
        return {}
    if not audio_file or not audio_file.tags:
        return {}

    def first_tag(*names):
        for name in names:
            value = audio_file.tags.get(name)
            if isinstance(value, (list, tuple)):
                value = value[0] if value else None
            if value:
                return str(value).strip()
        return None

    return {
        "title": first_tag("title"),
        "artist": first_tag("artist", "albumartist"),
        "album": first_tag("album"),
    }


def infer_track_title_artist(path: Path):
    clean_name = clean_filename_title(path.name)
    match = re.match(r"^(.+?)\s+-\s+(.+)$", clean_name)
    if match:
        return match.group(2).strip(), match.group(1).strip()

    featured_artist = re.search(r"\((?:feat|ft|featuring)\.?\s+([^\)]+)\)", clean_name, flags=re.I)
    artist = featured_artist.group(1).strip() if featured_artist else "Unknown Artist"
    return clean_name, artist


def parse_range_header(range_header: str, file_size: int):
    if not range_header or not range_header.lower().startswith("bytes="):
        return None

    range_value = range_header.split("=", 1)[1].strip()
    if not range_value or "," in range_value:
        return None

    if range_value.startswith("-"):
        try:
            suffix_length = int(range_value[1:])
        except ValueError:
            return None
        if suffix_length <= 0 or file_size <= 0:
            return None
        start = max(file_size - suffix_length, 0)
        end = file_size - 1
        return start, end

    start_text, sep, end_text = range_value.partition("-")
    try:
        start = int(start_text)
    except ValueError:
        return None

    if start < 0 or start >= file_size:
        return None

    try:
        end = file_size - 1 if not sep or not end_text else int(end_text)
    except ValueError:
        return None
    if end < start:
        return None

    return start, min(end, file_size - 1)


def get_music_files(root: Path):
    if not root.exists():
        return []
    files = []
    for item in sorted(root.rglob("*")):
        if item.is_file() and item.suffix.lower() in ALLOWED_EXTENSIONS:
            files.append(item)
    return files


def get_song_files():
    return get_music_files(UPLOAD_DIR)


def track_from_path(path: Path):
    title, artist = infer_track_title_artist(path)
    metadata = read_audio_metadata(path)
    title = metadata.get("title") or title
    artist = metadata.get("artist") or artist
    suffix = path.suffix.lower().lstrip(".")
    quality = extract_quality_label(path)
    artists = split_artists(artist)
    cover_path = find_cover_for_track(path)
    track_id = build_track_id(path)
    return {
        "id": track_id,
        "title": title,
        "artist": artist,
        "album": metadata.get("album") or "Unknown Album",
        "artists": artists,
        "quality": quality,
        "duration": 0,
        "format": suffix or "unknown",
        "cover_url": f"/api/cover/{track_id}" if cover_path else None,
        "filename": path.name,
        "size": path.stat().st_size,
        "path": str(path),
        "url": f"/api/stream/{track_id}",
    }


def get_music_library():
    return [track_from_path(item) for item in get_song_files()]


def get_artist_library():
    artists = {}
    for song in get_music_library():
        for artist in song.get("artists") or split_artists(song.get("artist", "")):
            artists.setdefault(artist.casefold(), {"name": artist, "songs": []})["songs"].append(song)
    return sorted(artists.values(), key=lambda item: item["name"].casefold())


def find_track_by_id(track_id: str):
    for item in get_music_library():
        if item["id"] == track_id:
            return Path(item["path"])
    return None


def get_audio_quality(path: Path):
    result = {
        "format": path.suffix.lower().lstrip(".").upper() or "UNKNOWN",
        "codec": None,
        "bitrate_kbps": None,
        "sample_rate_hz": None,
        "bit_depth": None,
        "channels": None,
        "duration_seconds": None,
        "lossless": None,
        "file_size_bytes": path.stat().st_size if path.exists() else 0,
    }
    if MutagenFile is None:
        return result

    try:
        audio_file = MutagenFile(path)
    except Exception:
        return result
    if not audio_file or not audio_file.info:
        return result

    info = audio_file.info
    codec = getattr(info, "codec", None)
    if codec:
        result["codec"] = str(codec).strip()

    bitrate = getattr(info, "bitrate", None)
    if bitrate:
        result["bitrate_kbps"] = round(float(bitrate) / 1000)

    sample_rate = getattr(info, "sample_rate", None)
    if sample_rate:
        result["sample_rate_hz"] = int(sample_rate)

    bit_depth = getattr(info, "bits_per_sample", None)
    if bit_depth:
        result["bit_depth"] = int(bit_depth)

    channels = getattr(info, "channels", None)
    if channels:
        result["channels"] = int(channels)

    duration = getattr(info, "length", None)
    if duration:
        result["duration_seconds"] = float(duration)
        if result["bitrate_kbps"] is None and path.exists():
            result["bitrate_kbps"] = round(path.stat().st_size * 8 / duration / 1000)

    if result["codec"]:
        codec_name = result["codec"].lower()
        lossless_codecs = ("alac", "flac", "pcm", "wavpack", "ape", "tta", "tak", "shorten")
        result["lossless"] = any(name in codec_name for name in lossless_codecs)
    elif result["format"] in {"FLAC", "WAV", "AIFF", "ALAC"}:
        result["lossless"] = True

    return result


def is_alac_file(path: Path) -> bool:
    if path.suffix.lower() not in {".m4a", ".alac"}:
        return False
    if path.suffix.lower() == ".alac":
        return True
    if bool(re.search(r"\bALAC\b", path.stem, flags=re.I)):
        return True
    quality = get_audio_quality(path)
    codec = (quality.get("codec") or "").lower()
    return "alac" in codec


def find_cover_for_track(track_path: Path):
    cover_names = [
        track_path.with_suffix(".jpg"),
        track_path.with_suffix(".jpeg"),
        track_path.with_suffix(".png"),
        track_path.parent / "cover.jpg",
        track_path.parent / "cover.jpeg",
        track_path.parent / "cover.png",
    ]
    for cover_path in cover_names:
        if cover_path.exists() and cover_path.is_file():
            return cover_path
    return None


def send_json(handler, status, payload):
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, Range")
    handler.end_headers()
    handler.wfile.write(body)


def send_file_response(handler, file_path: Path):
    if not file_path.exists() or not file_path.is_file():
        send_json(handler, 404, {"error": "Track not found"})
        return

    file_size = file_path.stat().st_size
    mime_type = AUDIO_MIME_TYPES.get(file_path.suffix.lower())
    if not mime_type:
        mime_type, _ = mimetypes.guess_type(str(file_path))
    if not mime_type:
        mime_type = "application/octet-stream"

    range_header = handler.headers.get("Range")
    start = 0
    end = file_size - 1
    status_code = 200
    content_length = file_size
    content_range = None

    if range_header:
        parsed_range = parse_range_header(range_header, file_size)
        if parsed_range is None:
            handler.send_response(416)
            handler.send_header("Content-Type", mime_type)
            handler.send_header("Content-Range", f"bytes */{file_size}")
            handler.send_header("Accept-Ranges", "bytes")
            handler.send_header("Content-Length", "0")
            handler.send_header("Access-Control-Allow-Origin", "*")
            handler.send_header("Access-Control-Expose-Headers", "Accept-Ranges, Content-Range, Content-Length")
            handler.end_headers()
            return

        start, end = parsed_range
        status_code = 206
        content_length = end - start + 1
        content_range = f"bytes {start}-{end}/{file_size}"

    handler.send_response(status_code)
    handler.send_header("Content-Type", mime_type)
    handler.send_header("Accept-Ranges", "bytes")
    handler.send_header("Content-Length", str(content_length))
    handler.send_header("Access-Control-Expose-Headers", "Accept-Ranges, Content-Range, Content-Length")
    if content_range:
        handler.send_header("Content-Range", content_range)
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, Range")
    handler.end_headers()

    with file_path.open("rb") as audio_file:
        audio_file.seek(start)
        remaining = content_length
        while remaining > 0:
            chunk = audio_file.read(min(CHUNK_SIZE, remaining))
            if not chunk:
                break
            handler.wfile.write(chunk)
            remaining -= len(chunk)


def send_transcoded_flac_response(handler, file_path: Path):
    ffmpeg_path = shutil.which("ffmpeg")
    if not ffmpeg_path and imageio_ffmpeg is not None:
        try:
            ffmpeg_path = imageio_ffmpeg.get_ffmpeg_exe()
        except (OSError, RuntimeError):
            ffmpeg_path = None
    if not ffmpeg_path:
        message = "FFmpeg is required to stream ALAC files. Install FFmpeg and add it to PATH, or install backend requirements."
        print(message, file=sys.stderr)
        send_json(handler, 503, {"error": message})
        return

    command = [
        ffmpeg_path,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(file_path),
        "-map",
        "0:a:0",
        "-vn",
        "-c:a",
        "flac",
        "-compression_level",
        "5",
        "-f",
        "flac",
        "pipe:1",
    ]
    try:
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=None,
            bufsize=0,
        )
    except OSError as error:
        message = f"Unable to start FFmpeg for ALAC playback: {error}"
        print(message, file=sys.stderr)
        send_json(handler, 503, {"error": message})
        return

    handler.send_response(200)
    handler.send_header("Content-Type", "audio/flac")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, Range")
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()

    client_disconnected = False
    try:
        while True:
            chunk = process.stdout.read(CHUNK_SIZE)
            if not chunk:
                break
            handler.wfile.write(chunk)
    except (BrokenPipeError, ConnectionResetError):
        client_disconnected = True
    finally:
        if process.stdout:
            process.stdout.close()
        if client_disconnected and process.poll() is None:
            process.terminate()
        return_code = process.wait()
        if return_code and not client_disconnected:
            print(
                f"FFmpeg exited with status {return_code} while transcoding {file_path}",
                file=sys.stderr,
            )


class MusicHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, Range")
        self.end_headers()

    def do_HEAD(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path.startswith("/api/stream/"):
            track_id = path.split("/api/stream/", 1)[1]
            target = find_track_by_id(track_id)
            if target is None:
                self.send_response(404)
                self.end_headers()
                return
            file_size = target.stat().st_size
            mime_type = AUDIO_MIME_TYPES.get(target.suffix.lower(), "audio/mp4")
            self.send_response(200)
            self.send_header("Content-Type", mime_type)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(file_size))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, Range")
            self.send_header("Access-Control-Expose-Headers", "Accept-Ranges, Content-Range, Content-Length")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

    def log_message(self, format, *args):
        return

    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        if path == "/api/health":
            send_json(self, 200, {"status": "ok", "service": "NhacCuaTao backend"})
            return

        if path == "/api/songs":
            send_json(self, 200, {"songs": get_music_library()})
            return

        if path == "/api/scan":
            songs = get_music_library()
            send_json(self, 200, {"songs": songs, "count": len(songs)})
            return

        if path == "/api/artists":
            try:
                send_json(self, 200, {"artists": get_artist_library()})
            except (OSError, ValueError) as error:
                send_json(self, 500, {"error": str(error)})
            return

        if path in {"/api/requests", "/api/playlists", "/api/favorites"}:
            collection = path.rsplit("/", 1)[1]
            try:
                send_json(self, 200, {collection: load_json_collection(collection)})
            except (OSError, ValueError) as error:
                send_json(self, 500, {"error": str(error)})
            return

        if path.startswith("/api/quality/"):
            track_id = path.split("/api/quality/", 1)[1]
            target = find_track_by_id(track_id)
            if target is None:
                send_json(self, 404, {"error": "Track not found"})
                return
            send_json(self, 200, {"quality": get_audio_quality(target)})
            return

        if path.startswith("/api/cover/"):
            track_id = path.split("/api/cover/", 1)[1]
            target = find_track_by_id(track_id)
            if target is None:
                send_json(self, 404, {"error": "Cover not found"})
                return
            cover_path = find_cover_for_track(target)
            if cover_path is None:
                send_json(self, 404, {"error": "Cover not found"})
                return
            mime_type, _ = mimetypes.guess_type(str(cover_path))
            if not mime_type:
                mime_type = "image/jpeg"
            self.send_response(200)
            self.send_header("Content-Type", mime_type)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(cover_path.stat().st_size))
            self.end_headers()
            with cover_path.open("rb") as art_file:
                self.wfile.write(art_file.read())
            return

        if path.startswith("/api/stream/"):
            track_id = path.split("/api/stream/", 1)[1]
            target = find_track_by_id(track_id)
            if target is None:
                send_json(self, 404, {"error": "Track not found"})
                return
            query_params = parse_qs(parsed.query)
            force_direct = (
                query_params.get("direct", ["0"])[0] in {"1", "true"}
                or query_params.get("raw", ["0"])[0] in {"1", "true"}
            )
            user_agent = self.headers.get("User-Agent", "")
            is_apple_native = bool(
                re.search(r"\b(iPhone|iPad|iPod|Macintosh)\b", user_agent)
                and not re.search(r"\b(Chrome|Chromium|CriOS|Android)\b", user_agent)
            )
            if is_alac_file(target) and not force_direct and not is_apple_native:
                send_transcoded_flac_response(self, target)
                return
            send_file_response(self, target)
            return

        send_json(self, 404, {"error": "Route not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path in {"/api/requests", "/api/playlists", "/api/favorites"}:
            collection = path.rsplit("/", 1)[1]
            try:
                payload = self.read_json_body()
                if collection == "requests":
                    title = str(payload.get("title", "")).strip()
                    artist = str(payload.get("artist", "")).strip()
                    if not title or not artist:
                        send_json(self, 400, {"error": "Song title and artist are required"})
                        return
                    entry = {
                        "id": uuid.uuid4().hex,
                        "title": title,
                        "artist": artist,
                        "notes": str(payload.get("notes", "")).strip(),
                        "created_at": datetime.now(timezone.utc).isoformat(),
                        "status": "pending",
                    }
                elif collection == "playlists":
                    name = str(payload.get("name", "")).strip()
                    if not name:
                        send_json(self, 400, {"error": "Playlist name is required"})
                        return
                    entry = {
                        "id": uuid.uuid4().hex,
                        "name": name,
                        "track_ids": [],
                        "created_at": datetime.now(timezone.utc).isoformat(),
                    }
                else:
                    entry = self.validate_favorite(payload)
                    entry["added_at"] = datetime.now(timezone.utc).isoformat()

                with DATA_LOCK:
                    collection_data = load_json_collection(collection)
                    if collection == "favorites":
                        existing = next((item for item in collection_data if item.get("type") == entry["type"] and item.get("id") == entry["id"]), None)
                        if existing:
                            send_json(self, 200, {"favorite": existing})
                            return
                    collection_data.append(entry)
                    save_json_collection(collection, collection_data)
                send_json(self, 201, {"item": entry, collection: collection_data})
            except (ValueError, json.JSONDecodeError) as error:
                send_json(self, 400, {"error": str(error)})
            except OSError as error:
                send_json(self, 500, {"error": str(error)})
            return

        if path.startswith("/api/playlists/") and path.endswith("/tracks"):
            playlist_id = path.split("/")[3]
            try:
                payload = self.read_json_body()
                track_id = str(payload.get("track_id", "")).strip()
                if not track_id:
                    send_json(self, 400, {"error": "Track ID is required"})
                    return
                with DATA_LOCK:
                    playlists = load_json_collection("playlists")
                    playlist = next((item for item in playlists if item.get("id") == playlist_id), None)
                    if playlist is None:
                        send_json(self, 404, {"error": "Playlist not found"})
                        return
                    if track_id not in playlist["track_ids"]:
                        playlist["track_ids"].append(track_id)
                        save_json_collection("playlists", playlists)
                send_json(self, 200, {"playlist": playlist})
            except (ValueError, json.JSONDecodeError) as error:
                send_json(self, 400, {"error": str(error)})
            except OSError as error:
                send_json(self, 500, {"error": str(error)})
            return

        if path == "/api/upload":
            try:
                content_type = self.headers.get("Content-Type", "")
                if "multipart/form-data" not in content_type:
                    send_json(self, 400, {"error": "Expected multipart/form-data"})
                    return

                content_length = int(self.headers.get("Content-Length", "0"))
                raw_body = self.rfile.read(content_length)
                boundary = content_type.split("boundary=", 1)[1].strip().strip('"')
                full_message = f"Content-Type: {content_type}\r\n\r\n".encode("utf-8") + raw_body
                message = BytesParser(policy=email_default).parsebytes(full_message)

                uploaded_tracks = []
                for part in message.iter_parts():
                    filename = part.get_filename()
                    if not filename:
                        continue
                    payload = part.get_payload(decode=True)
                    if payload is None:
                        continue

                    safe_name = safe_filename(filename)
                    file_path = UPLOAD_DIR / safe_name
                    index = 1
                    while file_path.exists():
                        file_path = UPLOAD_DIR / f"{Path(safe_name).stem}_{index}{Path(safe_name).suffix}"
                        index += 1

                    with file_path.open("wb") as output_file:
                        output_file.write(payload)

                    uploaded_tracks.append(track_from_path(file_path))

                if not uploaded_tracks:
                    send_json(self, 400, {"error": "No valid file uploaded"})
                    return

                send_json(self, 200, {"message": "Files uploaded successfully", "songs": uploaded_tracks})
                return
            except Exception as exc:
                send_json(self, 500, {"error": f"Upload failed: {str(exc)}"})
                return

        send_json(self, 404, {"error": "Route not found"})

    def do_PUT(self):
        parsed = urlparse(self.path)
        segments = [segment for segment in unquote(parsed.path).split("/") if segment]
        if len(segments) != 3 or segments[:2] != ["api", "playlists"]:
            send_json(self, 404, {"error": "Route not found"})
            return
        playlist_id = segments[2]
        try:
            payload = self.read_json_body()
            with DATA_LOCK:
                playlists = load_json_collection("playlists")
                playlist = next((item for item in playlists if item.get("id") == playlist_id), None)
                if playlist is None:
                    send_json(self, 404, {"error": "Playlist not found"})
                    return
                if "name" in payload:
                    name = str(payload["name"]).strip()
                    if not name:
                        send_json(self, 400, {"error": "Playlist name cannot be empty"})
                        return
                    playlist["name"] = name
                if "track_ids" in payload:
                    track_ids = payload["track_ids"]
                    if not isinstance(track_ids, list) or any(not isinstance(track_id, str) for track_id in track_ids):
                        send_json(self, 400, {"error": "track_ids must be an array of strings"})
                        return
                    playlist["track_ids"] = list(dict.fromkeys(track_ids))
                save_json_collection("playlists", playlists)
            send_json(self, 200, {"playlist": playlist})
        except (ValueError, json.JSONDecodeError) as error:
            send_json(self, 400, {"error": str(error)})
        except OSError as error:
            send_json(self, 500, {"error": str(error)})

    def do_DELETE(self):
        parsed = urlparse(self.path)
        segments = [segment for segment in unquote(parsed.path).split("/") if segment]
        query = parse_qs(parsed.query)
        try:
            if parsed.path == "/api/favorites":
                favorite_type = query.get("type", [""])[0]
                favorite_id = query.get("id", [""])[0]
                if not favorite_type or not favorite_id:
                    send_json(self, 400, {"error": "Favorite type and ID are required"})
                    return
                with DATA_LOCK:
                    favorites = load_json_collection("favorites")
                    remaining = [item for item in favorites if not (item.get("type") == favorite_type and item.get("id") == favorite_id)]
                    save_json_collection("favorites", remaining)
                send_json(self, 200, {"favorites": remaining})
                return

            if len(segments) == 3 and segments[:2] == ["api", "playlists"]:
                with DATA_LOCK:
                    playlists = load_json_collection("playlists")
                    remaining = [item for item in playlists if item.get("id") != segments[2]]
                    if len(remaining) == len(playlists):
                        send_json(self, 404, {"error": "Playlist not found"})
                        return
                    favorites = load_json_collection("favorites")
                    remaining_favorites = [
                        item for item in favorites
                        if not (item.get("type") == "playlist" and item.get("id") == segments[2])
                    ]
                    save_json_collection("playlists", remaining)
                    if len(remaining_favorites) != len(favorites):
                        save_json_collection("favorites", remaining_favorites)
                send_json(self, 200, {"playlists": remaining})
                return

            if len(segments) == 5 and segments[:2] == ["api", "playlists"] and segments[3] == "tracks":
                playlist_id, track_id = segments[2], segments[4]
                with DATA_LOCK:
                    playlists = load_json_collection("playlists")
                    playlist = next((item for item in playlists if item.get("id") == playlist_id), None)
                    if playlist is None:
                        send_json(self, 404, {"error": "Playlist not found"})
                        return
                    playlist["track_ids"] = [item for item in playlist["track_ids"] if item != track_id]
                    save_json_collection("playlists", playlists)
                send_json(self, 200, {"playlist": playlist})
                return
        except (ValueError, json.JSONDecodeError) as error:
            send_json(self, 400, {"error": str(error)})
            return
        except OSError as error:
            send_json(self, 500, {"error": str(error)})
            return
        send_json(self, 404, {"error": "Route not found"})

    def read_json_body(self):
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length <= 0 or content_length > 1024 * 1024:
            raise ValueError("JSON request body is required and must be under 1 MB")
        try:
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("Request body must contain valid JSON") from error
        if not isinstance(payload, dict):
            raise ValueError("JSON request body must be an object")
        return payload

    @staticmethod
    def validate_favorite(payload):
        favorite_type = str(payload.get("type", "")).strip().lower()
        favorite_id = str(payload.get("id", "")).strip()
        name = str(payload.get("name", "")).strip()
        if favorite_type not in {"song", "album", "artist", "playlist"} or not favorite_id or not name:
            raise ValueError("Favorite type, ID, and name are required")
        return {"type": favorite_type, "id": favorite_id, "name": name}


def main():
    host = "0.0.0.0"
    port = int(os.environ.get("PORT", "5000"))
    initialize_data_store()
    server = ThreadingHTTPServer((host, port), MusicHandler)
    print(f"Music backend running on http://{host}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
