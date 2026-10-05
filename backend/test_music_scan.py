import sys
import http.client
import io
import json
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import app


class FakeResponseHandler:
    def __init__(self, range_header=None):
        self.headers = {'Range': range_header} if range_header else {}
        self.response_headers = {}
        self.status = None
        self.wfile = io.BytesIO()

    def send_response(self, status):
        self.status = status

    def send_header(self, name, value):
        self.response_headers[name] = value

    def end_headers(self):
        pass


class MusicScanTests(unittest.TestCase):
    def test_track_id_building_is_stable(self):
        file_path = Path('artist/song.mp3')
        self.assertEqual(app.build_track_id(file_path), 'song')

    def test_infer_track_title_artist_from_pattern(self):
        file_path = Path('artist - song.mp3')
        title, artist = app.infer_track_title_artist(file_path)
        self.assertEqual(title, 'song')
        self.assertEqual(artist, 'artist')

    def test_clean_filename_title_removes_noise_tokens(self):
        raw_name = '01. 01 NgoKhong1301 (feat. Wala) [ALAC] [16 bit - 44.1 kHz].m4a'
        cleaned = app.clean_filename_title(raw_name)
        self.assertEqual(cleaned, 'NgoKhong1301 (feat. Wala)')

    def test_infer_title_and_featured_artist_from_noisy_filename(self):
        file_path = Path('01. 01 NgoKhong1301 (feat. Wala) [ALAC] [16 bit - 44.1 kHz].m4a')
        title, artist = app.infer_track_title_artist(file_path)
        self.assertEqual(title, 'NgoKhong1301 (feat. Wala)')
        self.assertEqual(artist, 'Wala')

    def test_artist_title_parser_runs_after_filename_cleanup(self):
        file_path = Path('02. Artist Name - Song Name [FLAC] [24bit - 96kHz].flac')
        title, artist = app.infer_track_title_artist(file_path)
        self.assertEqual(title, 'Song Name')
        self.assertEqual(artist, 'Artist Name')

    def test_audio_metadata_overrides_filename_fallback(self):
        with TemporaryDirectory() as temp_dir:
            file_path = Path(temp_dir) / 'Filename title.mp3'
            file_path.touch()
            with patch.object(app, 'read_audio_metadata', return_value=(
                {'title': 'Tagged title', 'artist': 'Tagged artist'}
            )):
                track = app.track_from_path(file_path)
        self.assertEqual(track['title'], 'Tagged title')
        self.assertEqual(track['artist'], 'Tagged artist')

    def test_quality_label_is_separate_from_title(self):
        file_path = Path('01. 01 NgoKhong1301 (feat. Wala) [ALAC] [16 bit - 44.1 kHz].m4a')
        self.assertEqual(app.extract_quality_label(file_path), 'ALAC 16-bit / 44.1kHz • M4A')

    def test_audio_quality_uses_file_technical_metadata(self):
        with TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / 'audio.flac'
            source.write_bytes(b'flac-data')
            info = SimpleNamespace(
                codec='FLAC',
                bitrate=3000000,
                sample_rate=96000,
                bits_per_sample=24,
                channels=2,
                length=120.0,
            )
            with patch.object(app, 'MutagenFile', return_value=SimpleNamespace(info=info)):
                quality = app.get_audio_quality(source)

        self.assertEqual(quality['format'], 'FLAC')
        self.assertEqual(quality['codec'], 'FLAC')
        self.assertEqual(quality['bitrate_kbps'], 3000)
        self.assertEqual(quality['sample_rate_hz'], 96000)
        self.assertEqual(quality['bit_depth'], 24)
        self.assertTrue(quality['lossless'])

    def test_range_stream_sends_original_file_bytes(self):
        with TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / 'original.mp3'
            original_bytes = bytes(range(16))
            source.write_bytes(original_bytes)
            handler = FakeResponseHandler('bytes=2-5')
            app.send_file_response(handler, source)

        self.assertEqual(handler.status, 206)
        self.assertEqual(handler.response_headers['Content-Range'], 'bytes 2-5/16')
        self.assertEqual(handler.response_headers['Accept-Ranges'], 'bytes')
        self.assertEqual(handler.response_headers['Content-Type'], 'audio/mpeg')
        self.assertEqual(handler.wfile.getvalue(), original_bytes[2:6])

    def test_audio_mime_types_are_explicit_for_supported_formats(self):
        self.assertEqual(app.AUDIO_MIME_TYPES['.flac'], 'audio/flac')
        self.assertEqual(app.AUDIO_MIME_TYPES['.m4a'], 'audio/mp4')
        self.assertEqual(app.AUDIO_MIME_TYPES['.alac'], 'audio/mp4')
        self.assertEqual(app.AUDIO_MIME_TYPES['.wav'], 'audio/wav')
        self.assertEqual(app.AUDIO_MIME_TYPES['.mp3'], 'audio/mpeg')

    def test_split_artists_supports_collaboration_separators(self):
        self.assertEqual(app.split_artists('Minh Tốc & Lam'), ['Minh Tốc', 'Lam'])
        self.assertEqual(app.split_artists('Sơn Tùng M-TP feat. X'), ['Sơn Tùng M-TP', 'X'])
        self.assertEqual(app.split_artists('Artist A, Artist B ft Artist C'), ['Artist A', 'Artist B', 'Artist C'])
        self.assertEqual(app.split_artists('Artist A x Artist B / Artist C VS. Artist D'), ['Artist A', 'Artist B', 'Artist C', 'Artist D'])

    def test_track_contains_individual_artist_names_and_real_album_tag(self):
        with TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / 'song.flac'
            path.write_bytes(b'audio')
            with patch.object(app, 'read_audio_metadata', return_value={
                'title': 'Song', 'artist': 'Artist A feat. Artist B', 'album': 'Real Album'
            }):
                track = app.track_from_path(path)
        self.assertEqual(track['artists'], ['Artist A', 'Artist B'])
        self.assertEqual(track['album'], 'Real Album')

    def test_artist_library_includes_collab_song_for_every_artist(self):
        collab = {'id': 'song-1', 'artist': 'Minh Tốc & Lam', 'artists': ['Minh Tốc', 'Lam']}
        with patch.object(app, 'get_music_library', return_value=[collab]):
            artists = app.get_artist_library()
        self.assertEqual([item['name'] for item in artists], ['Lam', 'Minh Tốc'])
        self.assertEqual([item['songs'] for item in artists], [[collab], [collab]])

    def test_only_m4a_alac_uses_transcoding(self):
        with patch.object(app, 'get_audio_quality', return_value={'codec': 'ALAC'}):
            self.assertTrue(app.is_alac_file(Path('track.m4a')))
            self.assertFalse(app.is_alac_file(Path('track.flac')))
        self.assertTrue(app.is_alac_file(Path('track.alac')))

    def test_transcoded_flac_stream_is_piped_without_range_headers(self):
        class FakeProcess:
            def __init__(self):
                self.stdout = io.BytesIO(b'fLaC-audio-data')

            def wait(self):
                return 0

        handler = FakeResponseHandler('bytes=0-10')
        with patch.object(app.shutil, 'which', return_value='ffmpeg'), \
                patch.object(app.subprocess, 'Popen', return_value=FakeProcess()) as popen:
            app.send_transcoded_flac_response(handler, Path('track.m4a'))

        command = popen.call_args.args[0]
        self.assertIn('flac', command)
        self.assertEqual(handler.status, 200)
        self.assertEqual(handler.response_headers['Content-Type'], 'audio/flac')
        self.assertNotIn('Accept-Ranges', handler.response_headers)
        self.assertNotIn('Content-Length', handler.response_headers)
        self.assertEqual(handler.wfile.getvalue(), b'fLaC-audio-data')

    def test_missing_ffmpeg_returns_service_unavailable_and_logs_warning(self):
        handler = FakeResponseHandler()
        stderr = io.StringIO()
        with patch.object(app.shutil, 'which', return_value=None), \
            patch.object(app, 'imageio_ffmpeg', None), \
                patch.object(app.sys, 'stderr', stderr):
            app.send_transcoded_flac_response(handler, Path('track.m4a'))

        self.assertEqual(handler.status, 503)
        self.assertIn('FFmpeg', json.loads(handler.wfile.getvalue())['error'])
        self.assertIn('Install FFmpeg', stderr.getvalue())


class BackendCollectionApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = TemporaryDirectory()
        self.data_dir_patcher = patch.object(app, 'DATA_DIR', Path(self.temp_dir.name))
        self.data_dir_patcher.start()
        self.server = app.ThreadingHTTPServer(('127.0.0.1', 0), app.MusicHandler)
        self.server_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.server_thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.server_thread.join(timeout=2)
        self.data_dir_patcher.stop()
        self.temp_dir.cleanup()

    def request_json(self, method, path, payload=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        body = json.dumps(payload).encode('utf-8') if payload is not None else None
        headers = {'Content-Type': 'application/json'} if body is not None else {}
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        response_body = response.read()
        result = json.loads(response_body) if response_body else None
        status = response.status
        connection.close()
        return status, result

    def test_requests_are_validated_and_persisted(self):
        status, created = self.request_json('POST', '/api/requests', {
            'title': 'Test song', 'artist': 'Artist', 'notes': 'Hi-Res link'
        })
        self.assertEqual(status, 201)
        self.assertEqual(created['item']['status'], 'pending')
        status, stored = self.request_json('GET', '/api/requests')
        self.assertEqual(status, 200)
        self.assertEqual(stored['requests'][0]['title'], 'Test song')
        self.assertTrue((Path(self.temp_dir.name) / 'requests.json').exists())

    def test_playlist_crud_tracks_and_reordering(self):
        status, created = self.request_json('POST', '/api/playlists', {'name': 'Road trip'})
        playlist_id = created['item']['id']
        self.assertEqual(status, 201)
        self.request_json('POST', f'/api/playlists/{playlist_id}/tracks', {'track_id': 'track-a'})
        self.request_json('POST', f'/api/playlists/{playlist_id}/tracks', {'track_id': 'track-b'})
        status, updated = self.request_json('PUT', f'/api/playlists/{playlist_id}', {
            'track_ids': ['track-b', 'track-a', 'track-b']
        })
        self.assertEqual(status, 200)
        self.assertEqual(updated['playlist']['track_ids'], ['track-b', 'track-a'])
        self.request_json('DELETE', f'/api/playlists/{playlist_id}/tracks/track-a')
        status, playlists = self.request_json('GET', '/api/playlists')
        self.assertEqual(status, 200)
        self.assertEqual(playlists['playlists'][0]['track_ids'], ['track-b'])
        self.assertEqual(self.request_json('DELETE', f'/api/playlists/{playlist_id}')[0], 200)

    def test_favorites_deduplicate_and_delete_by_type_and_id(self):
        favorite = {'type': 'artist', 'id': 'artist-1', 'name': 'Artist One'}
        self.assertEqual(self.request_json('POST', '/api/favorites', favorite)[0], 201)
        self.assertEqual(self.request_json('POST', '/api/favorites', favorite)[0], 200)
        status, stored = self.request_json('GET', '/api/favorites')
        self.assertEqual(status, 200)
        self.assertEqual(len(stored['favorites']), 1)
        self.assertEqual(self.request_json('DELETE', '/api/favorites?type=artist&id=artist-1')[0], 200)

    def test_deleting_playlist_removes_its_favorite_reference(self):
        _, created = self.request_json('POST', '/api/playlists', {'name': 'Favorite playlist'})
        playlist_id = created['item']['id']
        self.request_json('POST', '/api/favorites', {
            'type': 'playlist', 'id': playlist_id, 'name': 'Favorite playlist'
        })
        self.assertEqual(self.request_json('DELETE', f'/api/playlists/{playlist_id}')[0], 200)
        _, favorites = self.request_json('GET', '/api/favorites')
        self.assertEqual(favorites['favorites'], [])

    def test_artist_endpoint_groups_collaboration_songs(self):
        collab = {'id': 'song-1', 'artist': 'Minh Tốc & Lam', 'artists': ['Minh Tốc', 'Lam']}
        with patch.object(app, 'get_music_library', return_value=[collab]):
            status, result = self.request_json('GET', '/api/artists')
        self.assertEqual(status, 200)
        self.assertEqual(len(result['artists']), 2)
        self.assertTrue(all(artist['songs'] == [collab] for artist in result['artists']))

    def test_get_song_files_supports_recursive_scan(self):
        songs = app.get_music_library()
        self.assertTrue(any(song['format'] in {'mp3', 'wav', 'flac', 'alac', 'm4a'} for song in songs))


if __name__ == '__main__':
    unittest.main()
