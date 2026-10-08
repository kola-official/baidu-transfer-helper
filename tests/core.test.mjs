import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../src/core.js", import.meta.url), "utf8");
const context = { globalThis: {}, URL, encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout };
context.globalThis = context;
vm.runInNewContext(source, context);
const { extractShareKey, normalizeDestination, parseSharePage, BaiduPanTransfer, extractPageNotice, decodePath, stripBdclnd, appendBdclnd } = context.BaiduTransferCore;

test("extractShareKey supports normal and surl links", () => {
  assert.equal(extractShareKey("https://pan.baidu.com/s/1abcDEF?pwd=1234"), "abcDEF");
  assert.equal(extractShareKey("https://pan.baidu.com/share/init?surl=xyz987"), "xyz987");
  assert.equal(extractShareKey("not a link"), null);
});

test("normalizeDestination canonicalizes paths", () => {
  assert.equal(normalizeDestination("/"), "");
  assert.equal(normalizeDestination(" 资料//2026/ "), "/资料/2026");
  assert.throws(() => normalizeDestination("/资料/../私密"), /不能包含/);
});

test("parseSharePage extracts files and directories", () => {
  const payload = { share_uk: 10, shareid: 20, bdstoken: "token", file_list: [
    { fs_id: 1, isdir: 1, server_filename: "dir", parent_path: "/share-root" },
    { fs_id: 2, isdir: 0, server_filename: "file.txt", parent_path: "/share-root" }
  ]};
  const result = parseSharePage(`<script>locals.mset(${JSON.stringify(payload)});</script>`);
  assert.equal(result.directories[0].name, "dir");
  assert.equal(result.files[0].name, "file.txt");
  assert.equal(result.shareRoot, "/share-root");
});

test("transferIds retries rate limits and encodes destination", async () => {
  const responses = [{ errno: 111 }, { errno: 0 }];
  const calls = [];
  const transfer = new BaiduPanTransfer({
    destination: "/资料",
    maxRetries: 2,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, text: async () => JSON.stringify(responses.shift()) };
    }
  });
  transfer.bdstoken = "t"; transfer.shareId = 1; transfer.userId = 2;
  // Avoid waiting in unit tests by making the first retry code use an immediate timer.
  const realSetTimeout = context.setTimeout;
  context.setTimeout = (fn) => realSetTimeout(fn, 0);
  await transfer.transferIds([3, 4], "/资料");
  assert.equal(calls.length, 2);
  assert.match(calls[0].options.body, /path=%2F%E8%B5%84%E6%96%99/);
});

// Regression: pwd-protected shares must carry the `randsk` returned by
// /share/verify on every follow-up /share/* call (as `sekey`). Missing it made
// Baidu answer an HTML "链接出错了" page, so recursive expansion of a folder
// that exceeded the transfer limit failed with "链接出错了".
test("pwd-protected share threads randsk through verify, list and transfer", async () => {
  const seen = [];
  const transfer = new BaiduPanTransfer({
    destination: "/",
    maxRetries: 0,
    fetch: async (url) => {
      seen.push(url);
      if (url.includes("/api/gettemplatevariable")) {
        return { ok: true, text: async () => JSON.stringify({ errno: 0, result: { bdstoken: "tk" } }) };
      }
      if (url.includes("/share/verify")) {
        return { ok: true, text: async () => JSON.stringify({ errno: 0, randsk: "RANDSK_ABC" }) };
      }
      if (/\/s\/1/.test(url)) {
        const payload = {
          share_uk: 10, shareid: 20, bdstoken: "tk",
          file_list: [{ fs_id: 1, isdir: 1, server_filename: "9.16", parent_path: "/share-root" }]
        };
        return { ok: true, text: async () => `<script>locals.mset(${JSON.stringify(payload)});</script>` };
      }
      if (url.includes("/share/transfer")) {
        // First attempt (whole directory) hits the limit and forces a split;
        // every later attempt succeeds.
        const hitLimit = !seen.filter((u) => u.includes("/share/transfer")).slice(0, -1).length;
        const errno = hitLimit ? 12 : 0;
        return { ok: true, text: async () => JSON.stringify(errno === 12
          ? { errno: 12, target_file_nums: 900, target_file_nums_limit: 500 }
          : { errno: 0 }) };
      }
      if (url.includes("/share/list")) {
        // Only an authorised call (with sekey) returns JSON.
        if (!/sekey=RANDSK_ABC/.test(url)) {
          return { ok: true, text: async () => "<html><title>啊哦，链接出错了</title></html>" };
        }
        return { ok: true, text: async () => JSON.stringify({ errno: 0, list: [{ fs_id: 2, isdir: 0, server_filename: "a.txt" }] }) };
      }
      return { ok: true, text: async () => JSON.stringify({ errno: 0 }) };
    }
  });

  await transfer.run("https://pan.baidu.com/s/1XUoScrxCCwWAUXLKPYS1SQ", "8888");

  assert.equal(transfer.randsk, "RANDSK_ABC", "randsk should be retained after verify");
  const listCall = seen.find((u) => u.includes("/share/list"));
  assert.ok(listCall, "/share/list should be called during the split");
  assert.match(listCall, /sekey=RANDSK_ABC/, "/share/list must carry sekey");
  assert.match(listCall, /dir=\/share-root\/9\.16/, "dir should resolve inside the share root");
  const transferCalls = seen.filter((u) => u.includes("/share/transfer"));
  assert.ok(transferCalls.length >= 2, "a split should trigger a second transfer attempt");
  assert.ok(transferCalls.every((u) => /sekey=RANDSK_ABC/.test(u)), "/share/transfer must carry sekey");
});

// Regression: a custom save directory must not corrupt the in-share source
// path used to expand oversized folders.
test("split resolves share-internal path when a custom destination is set", async () => {
  const seen = [];
  const transfer = new BaiduPanTransfer({
    destination: "/资料/2026",
    maxRetries: 0,
    fetch: async (url) => {
      seen.push(url);
      if (url.includes("/api/gettemplatevariable")) {
        return { ok: true, text: async () => JSON.stringify({ errno: 0, result: { bdstoken: "tk" } }) };
      }
      if (/\/s\/1/.test(url)) {
        const payload = {
          share_uk: 10, shareid: 20, bdstoken: "tk",
          file_list: [{ fs_id: 1, isdir: 1, server_filename: "9.16", parent_path: "/share-root" }]
        };
        return { ok: true, text: async () => `<script>locals.mset(${JSON.stringify(payload)});</script>` };
      }
      if (url.includes("/share/transfer")) {
        const prior = seen.filter((u) => u.includes("/share/transfer")).slice(0, -1).length;
        return { ok: true, text: async () => JSON.stringify(prior === 0
          ? { errno: 12, target_file_nums: 900, target_file_nums_limit: 500 }
          : { errno: 0 }) };
      }
      if (url.includes("/share/list")) {
        return { ok: true, text: async () => JSON.stringify({ errno: 0, list: [{ fs_id: 2, isdir: 0, server_filename: "a.txt" }] }) };
      }
      return { ok: true, text: async () => JSON.stringify({ errno: 0 }) };
    }
  });

  await transfer.run("https://pan.baidu.com/s/1XUoScrxCCwWAUXLKPYS1SQ", "");

  const listCall = seen.find((u) => u.includes("/share/list"));
  assert.ok(listCall, "/share/list should be called during the split");
  assert.match(listCall, /dir=\/share-root\/9\.16/, "source dir must stay share-relative, not destination-relative");
  assert.ok(!/dir=[^&]*资料/.test(listCall), "destination must not leak into the source dir");
});

test("extractPageNotice surfaces readable text from HTML error pages", () => {
  assert.equal(extractPageNotice("<html><title>啊哦，链接出错了</title></html>"), "啊哦，链接出错了");
  assert.equal(extractPageNotice('{"err_msg":"分享已失效"}'), "分享已失效");
  assert.equal(extractPageNotice("<html><title>百度网盘</title></html>"), "");
});

test("describeErrno maps known codes and flags throttling", () => {
  const t = new BaiduPanTransfer({ destination: "/", fetch: async () => ({ ok: true, text: async () => "{}" }) });
  assert.match(t.describeErrno({ errno: 9019 }), /重新验证提取码/);
  assert.match(t.describeErrno({ errno: -6 }), /登录已过期/);
  assert.match(t.describeErrno({ errno: 111 }), /限流/);
  // An unknown code carrying a throttling notice should gain a retry hint.
  assert.match(t.describeErrno({ errno: 9999, show_msg: "请求超时，请稍后再试" }), /限流/);
  // A genuinely unknown code falls back to the server message.
  assert.equal(t.describeErrno({ errno: 8888, show_msg: "未知情况" }), "未知情况");
});

// Regression: a share whose root is a single oversized folder used to loop
// forever, because /share/list kept answering with that same folder instead of
// its contents. The recursion must stop and report an actionable error.
test("oversized root folder does not recurse forever when listing is self-referential", async () => {
  let shareListCalls = 0;
  let transferCalls = 0;
  const transfer = new BaiduPanTransfer({
    destination: "/资料",
    maxRetries: 0,
    maxDepth: 12,
    fetch: async (url) => {
      if (url.includes("/api/gettemplatevariable")) {
        return { ok: true, text: async () => JSON.stringify({ errno: 0, result: { bdstoken: "tk" } }) };
      }
      if (url.includes("/share/verify")) {
        return { ok: true, text: async () => JSON.stringify({ errno: 0, randsk: "RS" }) };
      }
      if (/\/s\/1/.test(url)) {
        const payload = {
          share_uk: 10, shareid: 20, bdstoken: "tk",
          file_list: [{ fs_id: 777, isdir: 1, server_filename: "9.16", parent_path: "/婚庆/2026/2026.9" }]
        };
        return { ok: true, text: async () => `<script>locals.mset(${JSON.stringify(payload)});</script>` };
      }
      if (url.includes("/share/transfer")) {
        transferCalls += 1;
        // The oversized folder always exceeds the limit.
        return { ok: true, text: async () => JSON.stringify({ errno: 12, target_file_nums: 900, target_file_nums_limit: 500 }) };
      }
      if (url.includes("/share/list")) {
        shareListCalls += 1;
        // Baidu keeps returning the folder itself, never its children.
        return { ok: true, text: async () => JSON.stringify({ errno: 0, list: [{ fs_id: 777, isdir: 1, server_filename: "9.16" }] }) };
      }
      return { ok: true, text: async () => JSON.stringify({ errno: 0 }) };
    }
  });

  let error = null;
  try { await transfer.run("https://pan.baidu.com/s/1XUoScrxCCwWAUXLKPYS1SQ", "8888"); }
  catch (e) { error = e; }

  assert.ok(error, "a self-referential listing must surface an error");
  assert.match(error.message, /无法拆分|未提供该目录的内部列表/);
  assert.equal(shareListCalls, 1, "listing should be attempted exactly once before bailing out");
  assert.ok(transferCalls <= 2, `transfer must not be retried endlessly (got ${transferCalls})`);
});

test("deep nesting is bounded by maxDepth", async () => {
  let depthProbe = 0;
  const transfer = new BaiduPanTransfer({
    destination: "/",
    maxRetries: 0,
    maxDepth: 2,
    fetch: async (url) => {
      if (url.includes("/api/gettemplatevariable")) {
        return { ok: true, text: async () => JSON.stringify({ errno: 0, result: { bdstoken: "tk" } }) };
      }
      if (/\/s\/1/.test(url)) {
        const payload = {
          share_uk: 10, shareid: 20, bdstoken: "tk",
          file_list: [{ fs_id: 1, isdir: 1, server_filename: "lvl0", parent_path: "/root" }]
        };
        return { ok: true, text: async () => `<script>locals.mset(${JSON.stringify(payload)});</script>` };
      }
      if (url.includes("/share/transfer")) {
        return { ok: true, text: async () => JSON.stringify({ errno: 12, target_file_nums: 900, target_file_nums_limit: 500 }) };
      }
      if (url.includes("/share/list")) {
        depthProbe += 1;
        // Each level returns a distinct child folder, so the walk keeps going
        // until maxDepth stops it.
        return { ok: true, text: async () => JSON.stringify({ errno: 0, list: [{ fs_id: 100 + depthProbe, isdir: 1, server_filename: `lvl${depthProbe}` }] }) };
      }
      return { ok: true, text: async () => JSON.stringify({ errno: 0 }) };
    }
  });

  let error = null;
  try { await transfer.run("https://pan.baidu.com/s/1XUoScrxCCwWAUXLKPYS1SQ", ""); }
  catch (e) { error = e; }

  assert.ok(error, "exceeding maxDepth must raise");
  assert.match(error.message, /层级过深/);
  assert.ok(depthProbe <= 3, `listing should stop near maxDepth (got ${depthProbe})`);
});

// Regression (the actual root cause of the "正在拆分处理 → 请求超时" loop):
// Baidu's /share/list resolves `dir` from the *account* root when `root=1` is
// present, so asking for `.../9.16` answers with `9.16` itself. That made the
// splitter believe a single oversized folder never gets smaller and it looped
// until Baidu throttled the client. `root` must never be sent.
test("share/list never sends root=1 (it makes dir self-referential)", async () => {
  const seen = [];
  const transfer = new BaiduPanTransfer({
    destination: "/资料2",
    maxRetries: 0,
    fetch: async (url) => {
      seen.push(url);
      if (url.includes("/api/gettemplatevariable")) {
        return { ok: true, text: async () => JSON.stringify({ errno: 0, result: { bdstoken: "tk" } }) };
      }
      if (url.includes("/share/verify")) {
        return { ok: true, text: async () => JSON.stringify({ errno: 0, randsk: "RS" }) };
      }
      if (/\/s\/1/.test(url)) {
        const payload = {
          share_uk: 10, shareid: 20, bdstoken: "tk",
          file_list: [{ fs_id: 777, isdir: 1, server_filename: "9.16", parent_path: "%2Fsharelink10-777" }]
        };
        return { ok: true, text: async () => `<script>locals.mset(${JSON.stringify(payload)});</script>` };
      }
      if (url.includes("/share/transfer")) {
        const prior = seen.filter((u) => u.includes("/share/transfer")).slice(0, -1).length;
        return { ok: true, text: async () => JSON.stringify(prior === 0
          ? { errno: 12, target_file_nums: 900, target_file_nums_limit: 500 }
          : { errno: 0 }) };
      }
      if (url.includes("/share/list")) {
        return { ok: true, text: async () => JSON.stringify({ errno: 0, list: [{ fs_id: 2, isdir: 0, server_filename: "a.jpg" }] }) };
      }
      return { ok: true, text: async () => JSON.stringify({ errno: 0 }) };
    }
  });

  await transfer.run("https://pan.baidu.com/s/1XUoScrxCCwWAUXLKPYS1SQ", "8888");

  const listCalls = seen.filter((u) => u.includes("/share/list"));
  assert.ok(listCalls.length >= 1, "/share/list should be called during the split");
  for (const call of listCalls) {
    assert.ok(!/[?&]root=/.test(call), `root must not be sent to /share/list (got ${call})`);
  }
  // parent_path is URL-encoded on the share page; it must be decoded before use.
  assert.equal(transfer.shareRoot, "/sharelink10-777", "shareRoot should be decoded");
  assert.match(listCalls[0], /dir=\/sharelink10-777\/9\.16/, "dir should use the decoded share root");
});

test("decodePath decodes percent-encoded share roots", () => {
  assert.equal(decodePath("%2Fsharelink10-777"), "/sharelink10-777");
  assert.equal(decodePath("/plain/path"), "/plain/path");
  assert.equal(decodePath(""), "");
  // A malformed sequence must not throw — fall back to the raw value.
  assert.equal(decodePath("%"), "%");
});

test("stripBdclnd removes any pre-existing BDCLND entry", () => {
  assert.equal(stripBdclnd("BAIDUID=x; BDCLND=old; STOKEN=y"), "BAIDUID=x; STOKEN=y");
  assert.equal(stripBdclnd("BDCLND=old"), "");
  assert.equal(stripBdclnd("BAIDUID=x"), "BAIDUID=x");
});

test("appendBdclnd overwrites rather than duplicates the cookie", () => {
  // Field note: Baidu rejects /share/list when the stale BDCLND from an earlier
  // share is left in place, so the old value must be stripped first.
  const merged = appendBdclnd("BAIDUID=x; BDCLND=stale", "FRESH");
  assert.equal(merged, "BAIDUID=x;BDCLND=FRESH");
  assert.equal((merged.match(/BDCLND=/g) || []).length, 1, "BDCLND must appear exactly once");
});

test("persistRandsk writes the BDCLND cookie when a writer is provided", async () => {
  const written = [];
  const transfer = new BaiduPanTransfer({
    destination: "/",
    writeCookie: async (name, value, path, domain) => { written.push({ name, value, path, domain }); },
    fetch: async (url) => {
      if (url.includes("/api/gettemplatevariable")) {
        return { ok: true, text: async () => JSON.stringify({ errno: 0, result: { bdstoken: "tk" } }) };
      }
      if (url.includes("/share/verify")) {
        return { ok: true, text: async () => JSON.stringify({ errno: 0, randsk: "RS_XYZ" }) };
      }
      return { ok: true, text: async () => JSON.stringify({ errno: 0 }) };
    }
  });

  await transfer.verifyShare("XUoScrxCCwWAUXLKPYS1SQ", "8888");

  assert.equal(written.length, 1, "the BDCLND cookie should be written once");
  assert.equal(written[0].name, "BDCLND");
  assert.equal(written[0].value, "RS_XYZ");
  assert.equal(written[0].domain, ".baidu.com", "the cookie must cover pan.baidu.com subdomains");
});

// Without a cookie writer (e.g. a plain extension fetch), verification must
// still succeed instead of throwing.
test("persistRandsk is a no-op without a cookie writer", async () => {
  const transfer = new BaiduPanTransfer({
    destination: "/",
    fetch: async (url) => {
      if (url.includes("/api/gettemplatevariable")) {
        return { ok: true, text: async () => JSON.stringify({ errno: 0, result: { bdstoken: "tk" } }) };
      }
      if (url.includes("/share/verify")) {
        return { ok: true, text: async () => JSON.stringify({ errno: 0, randsk: "RS" }) };
      }
      return { ok: true, text: async () => JSON.stringify({ errno: 0 }) };
    }
  });

  await assert.doesNotReject(() => transfer.verifyShare("XUoScrxCCwWAUXLKPYS1SQ", "8888"));
  assert.equal(await transfer.persistRandsk(), false, "persisting without a writer reports false");
});
