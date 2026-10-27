import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, deviceLogin, premiumLogin, startTestServer, U1, U2, U3, WsClient } from './helpers';

test('autenticación premium vía hasJoined: desafío de un solo uso y nombre verificado', async () => {
  const env = await startTestServer();
  try {
    const ch = await api(env, 'POST', '/v1/auth/challenge');
    // Sin join previo → denegado
    const denied = await api(env, 'POST', '/v1/auth/premium', undefined, { challengeId: ch.json.id, username: 'Alice' });
    assert.equal(denied.status, 401);
    // El desafío ya se consumió: aunque ahora exista el join, no sirve
    env.join('Alice', U1, ch.json.serverId);
    const reuse = await api(env, 'POST', '/v1/auth/premium', undefined, { challengeId: ch.json.id, username: 'Alice' });
    assert.equal(reuse.status, 401);
    // Flujo correcto
    const token = await premiumLogin(env, 'Alice', U1);
    assert.ok(token.length > 20);
    // Sesión de dispositivo (offline) no puede usar social
    const dev = await deviceLogin(env);
    assert.equal((await api(env, 'GET', '/v1/social', dev.token)).status, 403);
    assert.equal((await api(env, 'GET', '/v1/social', 'x'.repeat(40))).status, 401);
  } finally {
    await env.close();
  }
});

test('amistad, chat en tiempo real, entrega, persistencia, reconexión y permisos', async () => {
  const env = await startTestServer();
  try {
    const a = await premiumLogin(env, 'Alice', U1);
    const b = await premiumLogin(env, 'Bob', U2);
    const c = await premiumLogin(env, 'Mallory', U3);

    // Búsqueda por identificador público (sin correos ni tokens)
    const s = await api(env, 'GET', '/v1/users/search?q=bob', a);
    assert.deepEqual(s.json.users, [{ uuid: U2, name: 'Bob' }]);

    // No amigos todavía → no se puede enviar
    const wa = await WsClient.connect(env, a);
    const wb = await WsClient.connect(env, b);
    wa.send({ type: 'send', to: U2, body: 'hola', clientId: 'c0' });
    assert.equal((await wa.next((e) => e.type === 'error')).code, 'SOCIAL_NOT_FRIENDS');

    // Solicitud y aceptación
    assert.equal((await api(env, 'POST', '/v1/friends/requests', a, { to: U2 })).json.status, 'sent');
    await wb.next((e) => e.type === 'friends-changed');
    const ov = await api(env, 'GET', '/v1/social', b);
    const req = ov.json.requests.find((r: any) => r.direction === 'incoming');
    assert.equal(req.uuid, U1);
    // Un tercero no puede aceptar la solicitud ajena
    assert.equal((await api(env, 'POST', `/v1/friends/requests/${req.id}/accept`, c)).status, 404);
    assert.equal((await api(env, 'POST', `/v1/friends/requests/${req.id}/accept`, b)).status, 200);
    const ovA = await api(env, 'GET', '/v1/social', a);
    assert.equal(ovA.json.friends[0].uuid, U2);
    assert.equal(ovA.json.friends[0].presence, 'online');

    // Mensaje en tiempo real + ack + confirmación de entrega
    wa.send({ type: 'send', to: U2, body: '  Hola <b>Bob</b>\u0007  ', clientId: 'c1' });
    const ack = await wa.next((e) => e.type === 'ack' && e.clientId === 'c1');
    assert.equal(ack.message.body, 'Hola <b>Bob</b>', 'se recortan controles; el HTML se trata como texto');
    const incoming = await wb.next((e) => e.type === 'message');
    assert.equal(incoming.message.id, ack.message.id);
    wb.send({ type: 'delivered', id: incoming.message.id });
    const delivered = await wa.next((e) => e.type === 'delivered');
    assert.equal(delivered.id, ack.message.id);

    // Indicador de escritura
    wb.send({ type: 'typing', to: U1 });
    assert.equal((await wa.next((e) => e.type === 'typing')).from, U2);

    // Límite de tamaño
    wa.send({ type: 'send', to: U2, body: 'x'.repeat(2001), clientId: 'big' });
    assert.equal((await wa.next((e) => e.type === 'error' && e.clientId === 'big')).code, 'VALIDATION');

    // Un tercero no puede leer ni escribir la conversación
    assert.equal((await api(env, 'GET', `/v1/messages/${U2}`, c)).status, 403);
    const wc = await WsClient.connect(env, c);
    wc.send({ type: 'send', to: U1, body: 'spam', clientId: 'm' });
    assert.equal((await wc.next((e) => e.type === 'error')).code, 'SOCIAL_NOT_FRIENDS');

    // Reconexión + persistencia del historial
    wb.close();
    await new Promise((r) => setTimeout(r, 100));
    wa.send({ type: 'send', to: U2, body: 'mientras no estabas', clientId: 'c2' });
    await wa.next((e) => e.type === 'ack' && e.clientId === 'c2');
    const wb2 = await WsClient.connect(env, b);
    const hist = await api(env, 'GET', `/v1/messages/${U1}?limit=1`, b);
    assert.equal(hist.json.messages.length, 1);
    assert.equal(hist.json.messages[0].body, 'mientras no estabas');
    assert.equal(hist.json.hasMore, true);
    const older = await api(env, 'GET', `/v1/messages/${U1}?before=${hist.json.messages[0].sentAt}`, b);
    assert.equal(older.json.messages[0].body, 'Hola <b>Bob</b>');
    const unread = (await api(env, 'GET', '/v1/social', b)).json.friends[0].unread;
    assert.equal(unread, 2);
    await api(env, 'POST', `/v1/messages/${U1}/read`, b);
    assert.equal((await api(env, 'GET', '/v1/social', b)).json.friends[0].unread, 0);

    // Bloqueo: elimina amistad e impide contacto y nuevas solicitudes
    assert.equal((await api(env, 'POST', '/v1/blocks', b, { uuid: U1 })).status, 200);
    wa.send({ type: 'send', to: U2, body: '¿sigues ahí?', clientId: 'c3' });
    assert.equal((await wa.next((e) => e.type === 'error' && e.clientId === 'c3')).code, 'SOCIAL_BLOCKED');
    assert.equal((await api(env, 'POST', '/v1/friends/requests', a, { to: U2 })).status, 403);
    assert.deepEqual((await api(env, 'GET', '/v1/users/search?q=bob', a)).json.users, []);

    // Denuncia
    assert.equal((await api(env, 'POST', '/v1/reports', b, { uuid: U1, reason: 'spam', messageId: ack.message.id })).status, 200);

    // Privacidad de presencia
    await api(env, 'DELETE', `/v1/blocks/${U1}`, b);
    await api(env, 'POST', '/v1/friends/requests', a, { to: U2 });
    await api(env, 'POST', '/v1/friends/requests', b, { to: U1 }); // solicitud cruzada → aceptación automática
    await api(env, 'PUT', '/v1/settings/social', b, { presence: 'nobody' });
    const ovA2 = await api(env, 'GET', '/v1/social', a);
    assert.equal(ovA2.json.friends[0].presence, 'offline');
    assert.equal(ovA2.json.friends[0].lastSeenAt, undefined);

    wa.close();
    wb2.close();
    wc.close();
  } finally {
    await env.close();
  }
});

test('WebSocket: autenticación obligatoria y límite de frecuencia de mensajes', async () => {
  const env = await startTestServer();
  try {
    const a = await premiumLogin(env, 'Alice', U1);
    const b = await premiumLogin(env, 'Bob', U2);
    await api(env, 'POST', '/v1/friends/requests', a, { to: U2 });
    await api(env, 'POST', '/v1/friends/requests', b, { to: U1 });
    const wa = await WsClient.connect(env, a);
    let limited = false;
    for (let i = 0; i < 12; i++) wa.send({ type: 'send', to: U2, body: `m${i}`, clientId: `x${i}` });
    try {
      const e = await wa.next((ev) => ev.type === 'error' && ev.code === 'RATE_LIMITED', 2000);
      limited = !!e;
    } catch {
      limited = false;
    }
    assert.ok(limited, 'el envío masivo debe limitarse');
    // Token inválido → error y cierre 4401
    const WebSocket = (await import('ws')).default;
    const raw = new WebSocket(env.wsUrl);
    await new Promise((r) => raw.once('open', r));
    raw.send(JSON.stringify({ type: 'auth', token: 'x'.repeat(40) }));
    const code = await new Promise<number>((r) => raw.once('close', (c: number) => r(c)));
    assert.equal(code, 4401);
    // Sin autenticar no se puede enviar nada
    const raw2 = new WebSocket(env.wsUrl);
    await new Promise((r) => raw2.once('open', r));
    raw2.send(JSON.stringify({ type: 'send', to: U2, body: 'hola' }));
    const first = await new Promise<any>((r) => raw2.once('message', (d: Buffer) => r(JSON.parse(d.toString()))));
    assert.equal(first.code, 'AUTH_EXPIRED');
    raw2.close();
    wa.close();
  } finally {
    await env.close();
  }
});
