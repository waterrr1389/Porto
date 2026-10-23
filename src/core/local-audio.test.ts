import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  audioFileExtension,
  audioProxyUrl,
  localAudioPath,
  parseAudioSources,
  wordAudioPath,
} from './local-audio.ts';

const PAYLOAD = {
  type: 'audioSourceList',
  audioSources: [
    { name: 'NHK16 センパイ [0]', url: 'http://127.0.0.1:5050/nhk16/audio/1.mp3' },
    { name: 'Broken' },
    { name: '', url: 'http://127.0.0.1:5050/x.mp3' },
    'not an object',
    { name: 'Opus', url: 'http://127.0.0.1:5050/taas/media/a b.opus' },
  ],
};

test('parses an audio source list and drops malformed entries', () => {
  assert.deepEqual(parseAudioSources(PAYLOAD), [
    { name: 'NHK16 センパイ [0]', url: 'http://127.0.0.1:5050/nhk16/audio/1.mp3' },
    { name: 'Opus', url: 'http://127.0.0.1:5050/taas/media/a b.opus' },
  ]);
  assert.deepEqual(parseAudioSources({ type: 'audioSourceList', audioSources: [] }), []);
});

test('rejects payloads that are not an audio source list', () => {
  for (const payload of [null, undefined, 'x', [], {}, { type: 'other', audioSources: [] }, { type: 'audioSourceList' }]) {
    assert.equal(parseAudioSources(payload), null, JSON.stringify(payload));
  }
});

test('builds same-origin proxy URLs with the path in the query', () => {
  assert.equal(
    audioProxyUrl('http://127.0.0.1:5050', 'http://127.0.0.1:5050/nhk16/audio/1.mp3'),
    '/api/audio/file?path=%2Fnhk16%2Faudio%2F1.mp3',
  );
  assert.equal(
    audioProxyUrl('http://127.0.0.1:5050/', 'http://127.0.0.1:5050/clip.mp3?x=1'),
    '/api/audio/file?path=%2Fclip.mp3%3Fx%3D1',
  );
  assert.equal(audioProxyUrl('http://127.0.0.1:5050', 'http://example.com/clip.mp3'), null);
  assert.equal(audioProxyUrl('http://127.0.0.1:5050', 'http://127.0.0.1:9999/clip.mp3'), null);
  assert.equal(audioProxyUrl('http://127.0.0.1:5050', 'not a url'), null);
});

test('reads the path out of one of our proxy URLs', () => {
  assert.equal(wordAudioPath('/api/audio/file?path=%2Fnhk16%2F1.mp3'), '/nhk16/1.mp3');
  assert.equal(wordAudioPath('/api/audio/file?path=%2Fclip.mp3%3Fx%3D1'), '/clip.mp3?x=1');
  assert.equal(wordAudioPath('/api/audio/file'), null);
  assert.equal(wordAudioPath('/api/audio/file?path='), null);
  assert.equal(wordAudioPath('http://127.0.0.1:8090/api/audio/file?path=%2Fa.mp3'), null);
  assert.equal(wordAudioPath('/api/other?path=%2Fa.mp3'), null);
});

test('accepts only paths on the configured base', () => {
  const base = 'http://127.0.0.1:5050';
  assert.equal(localAudioPath(base, '/nhk16/audio/1.mp3'), '/nhk16/audio/1.mp3');
  assert.equal(localAudioPath(base, '/clip.mp3?x=1'), '/clip.mp3?x=1');

  for (const bad of [
    '',
    'nhk16/1.mp3',
    '//example.com/1.mp3',
    'http://example.com/1.mp3',
    '/a/../secret.mp3',
    '/a/%2e%2e/secret.mp3',
    '/a\\..\\secret.mp3',
    '/a%5C..%5Csecret.mp3',
  ]) {
    assert.equal(localAudioPath(base, bad), null, bad);
  }
});

test('picks an extension from the content type, then the path, then mp3', () => {
  assert.equal(audioFileExtension('audio/mpeg', '/a/file.bin'), 'mp3');
  assert.equal(audioFileExtension('audio/ogg; codecs=opus', '/a/file.mp3'), 'ogg');
  assert.equal(audioFileExtension('audio/opus', '/a/file.mp3'), 'opus');
  assert.equal(audioFileExtension('audio/mp4', '/a/file'), 'm4a');
  assert.equal(audioFileExtension('application/octet-stream', '/a/file.ogg?x=1'), 'ogg');
  assert.equal(audioFileExtension('application/octet-stream', '/a/file.mp3'), 'mp3');
  assert.equal(audioFileExtension('application/octet-stream', '/a/file.xyz'), 'mp3');
});
