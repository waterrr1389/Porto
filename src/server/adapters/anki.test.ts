import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createAnki } from './anki.ts';

interface AnkiRequest {
  action: string;
  version: number;
  key?: string;
  params: Record<string, unknown>;
}

interface FakeAnki {
  url: string;
  requests: AnkiRequest[];
  close(): Promise<void>;
}

async function fakeAnki(reply: (request: AnkiRequest) => unknown): Promise<FakeAnki> {
  const requests: AnkiRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as AnkiRequest;
      requests.push(body);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reply(body)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('stores media files and then adds the note', async () => {
  const server = await fakeAnki((request) =>
    request.action === 'addNote' ? { result: 1_700_000_000_123, error: null } : { result: null, error: null },
  );
  try {
    const anki = createAnki({ url: server.url, apiKey: null, deck: 'JP::Mining', model: 'Lapis' });
    const id = await anki.addNote(
      { Expression: '自腹', Sentence: 'お前は<b>自腹</b>だ' },
      [
        { path: '/tmp/shot.jpg', fileName: 'shot.jpg' },
        { path: '/tmp/clip.mp3', fileName: 'clip.mp3' },
      ],
      ['mining'],
    );
    assert.equal(id, 1_700_000_000_123);
    assert.deepEqual(
      server.requests.map((request) => request.action),
      ['storeMediaFile', 'storeMediaFile', 'addNote'],
    );
    assert.deepEqual(server.requests[0]?.params, { filename: 'shot.jpg', path: '/tmp/shot.jpg' });
    assert.deepEqual(server.requests[1]?.params, { filename: 'clip.mp3', path: '/tmp/clip.mp3' });

    const note = server.requests[2]?.params.note as Record<string, unknown>;
    assert.equal(note.deckName, 'JP::Mining');
    assert.equal(note.modelName, 'Lapis');
    assert.deepEqual(note.fields, { Expression: '自腹', Sentence: 'お前は<b>自腹</b>だ' });
    assert.deepEqual(note.tags, ['mining']);
    assert.deepEqual(note.options, { allowDuplicate: true });

    for (const request of server.requests) {
      assert.equal(request.version, 6);
      assert.equal('key' in request, false, 'no key is sent without one');
    }
  } finally {
    await server.close();
  }
});

test('propagates the error AnkiConnect reports', async () => {
  const server = await fakeAnki(() => ({ result: null, error: 'cannot add note: missing field' }));
  try {
    const anki = createAnki({ url: server.url, apiKey: null, deck: 'JP', model: 'Lapis' });
    await assert.rejects(anki.addNote({}, [], []), /cannot add note: missing field/);
  } finally {
    await server.close();
  }
});

test('sends the api key when configured', async () => {
  const server = await fakeAnki(() => ({ result: [42], error: null }));
  try {
    const anki = createAnki({ url: server.url, apiKey: 'secret', deck: 'JP', model: 'Lapis' });
    await anki.findNotes('Expression:"x"');
    assert.equal(server.requests[0]?.key, 'secret');
  } finally {
    await server.close();
  }
});

test('scopes findNotes to the deck and returns the ids', async () => {
  const server = await fakeAnki(() => ({ result: [11, 12], error: null }));
  try {
    const anki = createAnki({ url: server.url, apiKey: null, deck: 'JP::Mining', model: 'Lapis' });
    assert.deepEqual(await anki.findNotes('Expression:"自腹"'), [11, 12]);
    assert.deepEqual(server.requests[0]?.params, {
      query: '"deck:JP::Mining" Expression:"自腹"',
    });
  } finally {
    await server.close();
  }
});

test('reports a clear error when Anki is not running', async () => {
  const server = await fakeAnki(() => ({ result: null, error: null }));
  const url = server.url;
  await server.close();

  const anki = createAnki({ url, apiKey: null, deck: 'JP', model: 'Lapis' });
  await assert.rejects(anki.addNote({}, [], []), /Anki is not reachable/);
});
