import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { verifyAlexaSignature } from '../src/alexa-verify.js';

// Feste Test-Fixtures (Throwaway-Keys, keine Geheimnisse):
// CA1 signiert leaf.crt; CA2 ist eine unzulaessige Gegen-CA.
const CA1_PEM = `-----BEGIN CERTIFICATE-----
MIIDYTCCAkmgAwIBAgIUCT+AlPqS6EXWpIOzwZ97SXAny9cwDQYJKoZIhvcNAQEL
BQAwQDELMAkGA1UEBhMCREUxGDAWBgNVBAoMD01laW5IZWxmZXIgVGVzdDEXMBUG
A1UEAwwOVGVzdCBSb290IENBIDEwHhcNMjYwOTIxMDkyNTIyWhcNNDAwNTMwMDky
NTIyWjBAMQswCQYDVQQGEwJERTEYMBYGA1UECgwPTWVpbkhlbGZlciBUZXN0MRcw
FQYDVQQDDA5UZXN0IFJvb3QgQ0EgMTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCC
AQoCggEBANTkWKnQnhtPHM9RSnjTfXRmUKlV/nrQ8S39ay3cT5sfHeKCBc64hXFP
98Ioz7fJb9sSqaAmeKexd08shJ83Dz/ljkqEFqAOtrUDoqbZ+k48nlDXMYJGlb7F
4+R2ITMXw6DaztovYqWiiir2x6VzkWDSeu0NEdlYhuafyn2hM96/7A1IcEsbFKxI
ASNR9IOGpXpWiEdj8QhNOHRqYlBZxwPB+VhN7+E3EoQ/5ysFSsYA+ARzrR73wa14
TVU24vYJWraG7x2h75JVYcQpqNEEc8gVozkCebWp4sM+b9n2Kb5BKnW71SUT2GBp
J3PV9YitzXQAoqp+Pjl8CY8+Kr5mXBsCAwEAAaNTMFEwHQYDVR0OBBYEFCJfDkod
6J+JDAxqZLv9G+uhlTrEMB8GA1UdIwQYMBaAFCJfDkod6J+JDAxqZLv9G+uhlTrE
MA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBALh9INnuiNI4OUWR
drdjS57A8XtUwDLny1uUFaq9yzJI/QwEsmf/S0TlMRgmnhahhSlAZCvha+ZRebbV
fUsoaMdRXNCHYxPGhli2MkCuAFEIVLz18QwFS5bL2SDcw6t/u5VsGwwbOTPDytvI
0YRITfVrtg0uIBPj7OCErZI3IBYQ+fOQx8IjeeMmhuaKMHfuMwYrpUHCmWNad7b4
EP5SAYmoqEEc3HrIFxDVESKRtsqXa8+2Qr6KpeOJNS6R06N4gcUABxhPjyc3Or4b
uFuzOFDpNXnSjzPtl8YXmDYhr1EyvTRBY45yoqiatiyGveOZpgI6pVDsleu/txm5
Mz/A8zY=
-----END CERTIFICATE-----`;

const CA2_PEM = `-----BEGIN CERTIFICATE-----
MIIDVzCCAj+gAwIBAgIUHzloBkwDq6A7DcRkkn7Bi8BAOBAwDQYJKoZIhvcNAQEL
BQAwOzELMAkGA1UEBhMCREUxEzARBgNVBAoMCk90aGVyIFRlc3QxFzAVBgNVBAMM
DlRlc3QgUm9vdCBDQSAyMB4XDTI2MDkyMTA5MjUyMloXDTQwMDUzMDA5MjUyMlow
OzELMAkGA1UEBhMCREUxEzARBgNVBAoMCk90aGVyIFRlc3QxFzAVBgNVBAMMDlRl
c3QgUm9vdCBDQSAyMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvqma
uUW/m11EtrN+DzA2dXHJLkMLJLtX6vil5MkftrddqqeXbuoQTH3bSBCW/mYxt31V
lAkq9dNt5AJSzU/gKH7dDjPbdTPb0cfgmmd6dW+PyUMMsUnAsrHeSTZYisv7k7Wy
kGKythwY+LZkytjPgmColIIrbttzdVT4088ft0eRxfaiuZvIhzLzqDAHomcYS9QP
Pdm2dSIk4eUwJnHJ981QVAINLAfwnttGI3+/c92NC8AYoodTAMQhDNsFJOI/ZtzP
Li8ihbcDpfN/OzJPNMQSguB6aScW57NvEYwR1+h6u0VJXkC7tYE1q2Z0t7Jdj1dT
gkVh6bU5C4ovtXqfAwIDAQABo1MwUTAdBgNVHQ4EFgQUK4+lKABlBNxhi9UExH8Y
EJQWR+kwHwYDVR0jBBgwFoAUK4+lKABlBNxhi9UExH8YEJQWR+kwDwYDVR0TAQH/
BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAQivIA/DveQNdYevQSvZk/ulzdnhH
QPYcdL5YJnfrxb6veVSu0FRDjnd0++M3Z1ihOSSpWH39xdofVekUuV3Eu4LwIu32
zN/RRK5wBTcx5XApZKVT+WahqAdWNPVGIllgSyBRgUY9KK4+98ZbkBYmv0juBwyf
lqOATXS7p9ukOEuQy5qqFVvB2GECurjitM0PFymAATx8rn8cja+///pxXbGEuH1S
ywmo5kss91noiEs3ICJvH4KOcT+Ijuf7vs0J2RSfhFgOjdbugDcg6+AYudEP8bNb
G6YDZwAaGYZ84olp7YIT6G94szZxpEWQDqCE06/uSujMpcJvd3f3O07TxA==
-----END CERTIFICATE-----`;

const LEAF_PEM = `-----BEGIN CERTIFICATE-----
MIIDWTCCAkGgAwIBAgIUE75EEA0hpu1ReozLemoHC/XJYGwwDQYJKoZIhvcNAQEL
BQAwQDELMAkGA1UEBhMCREUxGDAWBgNVBAoMD01laW5IZWxmZXIgVGVzdDEXMBUG
A1UEAwwOVGVzdCBSb290IENBIDEwHhcNMjYwOTIxMDkyNTIyWhcNNDAwNTMwMDky
NTIyWjBJMQswCQYDVQQGEwJERTEYMBYGA1UECgwPTWVpbkhlbGZlciBUZXN0MSAw
HgYDVQQDDBd0ZXN0Lm1laW5oZWxmZXIuaW52YWxpZDCCASIwDQYJKoZIhvcNAQEB
BQADggEPADCCAQoCggEBAKdT9fiZ9s1XowWeKAuMxrGAtKdBSmfAFfgjNjRKOHA6
4YVNpebGE8S7QRjBmLbYdBxO+46OMwg+6FkdROeVvWUQXzPOJIxRPHN7OXczo9+R
9KQ+DnscvWlnZ2X4s8mvU7wZLvL8uWn5SiaUHSFyAdvNOaT6kjR6utt/BB6/MbK4
oIOO10bgBcQ/7DRsmuqtK9oA63GBx23ixFxCxWmbPZpisEaYWf3SsRaFz/ewYVSL
lLnMHG/dfxkuBtmP9Gc/cWdQ9Pfolrr1SMGvcOxYsS8DWbHEYLrfKpAdjsboCTQs
f5Q1lZWFMvArjkvcDFcGF9UamOgyImnEAj6bjOTla3cCAwEAAaNCMEAwHQYDVR0O
BBYEFOcFiKraZgLkIGEwYJOZZdNiqcY4MB8GA1UdIwQYMBaAFCJfDkod6J+JDAxq
ZLv9G+uhlTrEMA0GCSqGSIb3DQEBCwUAA4IBAQAEOKqH4BgTeq5Wqb0XJfy8uGac
/JE/ZZ4G23UzWF93qwCiv8S9Bai5yU0bMI4RUcquXY9XbfTI3ndwXyXgQw3S1RoA
oZWza/IjFPzTN63QS6i3yb08igIcqo0oBA/b+8HMYYYpaOTYtsOv+WDDqnKC7SIt
134NdHzB8EEO+8u5iZKGyLeTlGfOr2Lw1DEK/i1lqqTy3teSdTwRa4ToPPjycxhc
8grIrAJXFHFfu8JDUszpnbSeL95JxZH+2jnnUCfQm/QXz3Ffl0Le8EfC22mKKRtY
S1+QQSNqm9pMFpCYwHsvMuVnKUlC2eSgVAveQ5zvHfEsWuuI5D0lPcm79B0q
-----END CERTIFICATE-----`;

const LEAF_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCnU/X4mfbNV6MF
nigLjMaxgLSnQUpnwBX4IzY0SjhwOuGFTaXmxhPEu0EYwZi22HQcTvuOjjMIPuhZ
HUTnlb1lEF8zziSMUTxzezl3M6PfkfSkPg57HL1pZ2dl+LPJr1O8GS7y/Llp+Uom
lB0hcgHbzTmk+pI0errbfwQevzGyuKCDjtdG4AXEP+w0bJrqrSvaAOtxgcdt4sRc
QsVpmz2aYrBGmFn90rEWhc/3sGFUi5S5zBxv3X8ZLgbZj/RnP3FnUPT36Ja69UjB
r3DsWLEvA1mxxGC63yqQHY7G6Ak0LH+UNZWVhTLwK45L3AxXBhfVGpjoMiJpxAI+
m4zk5Wt3AgMBAAECggEAGmj+IcbrVW3HpVNZLrmBgvK1kNCVVdrTnN6x537veYdR
oSCoVsxcwmhr1eR4niN78BvnSJDZLSwAsFAWWBciVZlH7X1T93G7AN8qKs5Txy3a
VzIURwo6OzC++TFP7z1lEgNHjcKl4TwfoAcwsd60vGSf/JIwEWhtpcdedxvmVDbe
iCyCTVFpMf0EWrenuqLcYAxpEmRII+t9ammA3jmqfSOt1xg9fWCBYcHzrgFVf0TX
7p+Qu9VPi2d3g7BmrNLp2U2wX0AUzrn/j+oCPsWNlU5HWaecIO4YA9/l0j0EZjvW
0PKZZeb8OG+ASB1ANBsfwZnrLCkKRtVuqmPZ0C5/AQKBgQDRVVgFbNcIJdJc0u9l
FJgngHYNjBrhoy5Ihg6mXWl8SLn4St1QYxrXDv85GzPlAqkktAXC2GcY8MB0UdCZ
/7Clp3PxUE61B7oAqJ5SFLgcP4WVVNDpAuUbDv3ar/HFiDHIHpi+ktHJJjoQLi3d
jS1n1WxAG7BCK2oiPbEXsKmZhwKBgQDMoV5bNgIZDiNa65YYrNYUtfvkEDusXrYI
22DJIIZHYyCgWp1sdb5qgWeRhEHLTXiIfMdbF2lyN7KZLwzoCRPgocfJuDiRi0Ru
deKKIhOBdjnwhC27ODgB/g6ianFyg8gau0USl8b2LXCVfPlpKWSR/EYWH8GqyiN9
aMxCa0RakQKBgQDQpLizx5TX+SKgBFo5rHovPRntTMzqQsP54yws44QlLTO255+I
5Q62dasrFxL1Wl6OR6RKXXj84dFg3r8FD1XY9ntYdUvNoeLhjy8l7qLG/QU/HyeO
Z6VE//9DfgSDdsjvhpeFsz7Ht4M951ktru4nxRA9IZvfh/gkIsslKp8QdwKBgQC2
Cw0FOevt3E0JsrIqK4CcljWL9AESXIO3J2tYIo4y7fX1kgegmLMYzxyTMUTTF42W
ZuN3n0FYskI50si5mHHNkj9JrpDssifj2Q37c0tFDieHWB/TAbWZ2CmuxeE9Tg1z
8owFeW8wTMZuxuqfaoqk8Phs8D17si6Wf+fPYtxBcQKBgCGpib88ZtXdH1WKd0X+
SfrZzZbLkx6yBZByFHGxX2mdEF6axP7i4EMdEJjBhDqdmQjonjLRF3WHIo3Maejs
FuV4wjSGNiLAITmAS80L7+0x3rFCrct8LYtN5Qp1ATiwFlVoxMlITbhXWpm8zfey
n1GniDp8EZKuvg/lhoPlzivc
-----END PRIVATE KEY-----`;

const GOOD_URL = 'https://s3.amazonaws.com/echo.api/test-chain.pem';
const BODY = Buffer.from('{"key":"wert"}');

function signBody(keyPem: string, body: Buffer): string {
  return createSign('RSA-SHA1').update(body).sign(keyPem, 'base64');
}

const originalFetch = globalThis.fetch;
let fetchCalls: string[] = [];

function stubFetch(chainPem: string | null): void {
  fetchCalls = [];
  globalThis.fetch = (async (url: string | URL) => {
    fetchCalls.push(String(url));
    if (chainPem === null) throw new Error('netz weg');
    return { ok: true, status: 200, text: async () => chainPem };
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

test('verifiziereAlexa: rawBody fehlt -> abgelehnt', async () => {
  const r = await verifyAlexaSignature(undefined, 'sig', GOOD_URL, undefined);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'rawBody fehlt');
});

test('verifiziereAlexa: Signature-Header fehlen -> abgelehnt', async () => {
  const r = await verifyAlexaSignature(BODY, undefined, GOOD_URL, undefined);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'Signature-Header fehlen');
});

test('verifiziereAlexa: CertChainUrl-Allowlist schlaegt zu (ohne Netz)', async () => {
  for (const url of [
    'http://s3.amazonaws.com/echo.api/x.pem',
    'https://evil.example/echo.api/x.pem',
    'https://s3.amazonaws.com/anders/x.pem',
    'https://s3.amazonaws.com:9999/echo.api/x.pem',
    'https://sub.s3.amazonaws.com.evil.example/echo.api/x.pem',
    'kein-url',
  ]) {
    const r = await verifyAlexaSignature(BODY, 'sig', url, undefined);
    assert.equal(r.ok, false, url);
    assert.equal(r.reason, 'CertChainUrl nicht erlaubt', url);
  }
});

test('verifiziereAlexa: gueltige Echo-API-URLs mit Port 8443/leer sind erlaubt', async () => {
  stubFetch(null);
  for (const url of [
    'https://s3.amazonaws.com/echo.api/x.pem',
    'https://s3.amazonaws.com:8443/echo.api/x.pem',
    'https://sub.amazonaws.com/echo.api/x.pem',
  ]) {
    const r = await verifyAlexaSignature(BODY, 'sig', url, undefined);
    assert.equal(r.ok, false, url);
    assert.match(r.reason, /^Chain-Fetch fehlgeschlagen/, url);
  }
});

test('verifiziereAlexa: Timestamp unparsebar -> abgelehnt', async () => {
  const r = await verifyAlexaSignature(BODY, 'sig', GOOD_URL, 'nicht-eine-zeit');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'Timestamp unparsebar');
});

test('verifiziereAlexa: Timestamp ausserhalb Toleranz (150 s) -> abgelehnt', async () => {
  const alt = new Date(Date.now() - 151_000).toISOString();
  const r = await verifyAlexaSignature(BODY, 'sig', GOOD_URL, alt);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'Timestamp ausserhalb Toleranz');
});

test('verifiziereAlexa: Timestamp innerhalb Toleranz wird durchgelassen (Fetch folgt)', async () => {
  stubFetch(null);
  const frisch = new Date(Date.now() - 100_000).toISOString();
  const r = await verifyAlexaSignature(BODY, 'sig', GOOD_URL, frisch);
  assert.equal(r.ok, false);
  assert.match(r.reason, /^Chain-Fetch fehlgeschlagen/);
});

test('verifiziereAlexa: gueltige Signatur ueber gestubbte Chain -> ok; Chain-Cache verhindert zweites Fetchen', async () => {
  stubFetch(`${LEAF_PEM}\n${CA1_PEM}`);
  const sig = signBody(LEAF_KEY_PEM, BODY);
  const r1 = await verifyAlexaSignature(BODY, sig, GOOD_URL, new Date().toISOString());
  assert.equal(r1.ok, true);
  const r2 = await verifyAlexaSignature(BODY, sig, GOOD_URL, new Date().toISOString());
  assert.equal(r2.ok, true);
  assert.equal(fetchCalls.length, 1);
});

test('verifiziereAlexa: falscher Schluessel -> Signatur ungueltig', async () => {
  stubFetch(`${LEAF_PEM}\n${CA1_PEM}`);
  const fremd = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const falschSig = createSign('RSA-SHA1')
    .update(BODY)
    .sign(fremd.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'base64');
  const r = await verifyAlexaSignature(BODY, falschSig, GOOD_URL, new Date().toISOString());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'Signatur ungueltig');
});

test('verifiziereAlexa: unterbrochene Chain (issuer != subject) -> abgelehnt', async () => {
  stubFetch(`${LEAF_PEM}\n${CA2_PEM}`);
  const r = await verifyAlexaSignature(
    BODY,
    signBody(LEAF_KEY_PEM, BODY),
    'https://s3.amazonaws.com/echo.api/inkonsistent.pem',
    new Date().toISOString()
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'Chain-Struktur inkonsistent');
});

test('verifiziereAlexa: Cache gilt auch fuer ungueltige Certs (kein refetch)', async () => {
  stubFetch(`${LEAF_PEM}\n${CA2_PEM}`);
  const url = 'https://s3.amazonaws.com/echo.api/cache-ungueltig.pem';
  const r1 = await verifyAlexaSignature(
    BODY,
    signBody(LEAF_KEY_PEM, BODY),
    url,
    new Date().toISOString()
  );
  assert.equal(r1.ok, false);
  const r2 = await verifyAlexaSignature(
    BODY,
    signBody(LEAF_KEY_PEM, BODY),
    url,
    new Date().toISOString()
  );
  assert.equal(r2.ok, false);
  assert.equal(fetchCalls.length, 1);
});
