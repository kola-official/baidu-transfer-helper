(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.BaiduTransferCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const ROOT_URL = "https://pan.baidu.com";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  class BaiduPanError extends Error {
    constructor(message, options = {}) {
      super(message);
      this.name = "BaiduPanError";
      this.errno = options.errno;
      this.response = options.response;
    }
  }

  function normalizeDestination(input = "") {
    const value = String(input).trim();
    if (!value || value === "/") return "";
    const parts = value
      .replace(/\\/g, "/")
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.some((part) => part === "." || part === "..")) {
      throw new BaiduPanError("目标目录不能包含 . 或 ..");
    }
    return `/${parts.join("/")}`;
  }

  function extractShareKey(input) {
    if (!input) return null;
    let value = String(input).trim();
    try {
      value = decodeURIComponent(value);
    } catch (_) {}
    const pathMatch = value.match(/\/s\/1([^/?#\s]+)/i);
    if (pathMatch) return pathMatch[1];
    const queryMatch = value.match(/[?&]surl=([^&#\s]+)/i);
    return queryMatch ? queryMatch[1] : null;
  }

  function encodePath(path) {
    return encodeURIComponent(path).replace(/%2F/gi, "/");
  }

  // Baidu hands back percent-encoded paths in the share page payload.
  function decodePath(path) {
    const value = String(path || "");
    try {
      return decodeURIComponent(value);
    } catch (_) {
      return value;
    }
  }

  // Baidu authorises /share/list via the BDCLND cookie (the "randsk" issued by
  // /share/verify), not via the `sekey` query parameter. The cookie must be
  // *replaced*, not merely appended: a stale BDCLND makes Baidu answer
  // errno -9. This mirrors the approach proven by drunkdream/baidu-free-transfer.
  const BDCLND_RE = /(?:^|;\s*)BDCLND=[^;]*/g;

  function stripBdclnd(cookie) {
    return String(cookie || "")
      .replace(BDCLND_RE, "")
      .replace(/^;+/, "")
      .replace(/;{2,}/g, ";")
      .replace(/;\s*$/, "")
      .trim();
  }

  function appendBdclnd(cookie, randsk) {
    if (!randsk) return cookie;
    const base = stripBdclnd(cookie);
    return `${base}${base && !base.endsWith(";") ? ";" : ""}BDCLND=${randsk}`;
  }

  // Pull a human-readable notice out of a Baidu HTML error page so callers
  // can log something meaningful instead of raw markup or "Unexpected token".
  function extractPageNotice(html) {
    const source = String(html || "");
    const patterns = [
      /<title[^>]*>([^<]{2,120})<\/title>/i,
      /"err_msg"\s*:\s*"([^"]{2,120})"/i,
      /"show_msg"\s*:\s*"([^"]{2,120})"/i,
      /<div[^>]*class="[^"]*(?:error|tip|notice)[^"]*"[^>]*>([^<]{2,120})</i
    ];
    for (const pattern of patterns) {
      const match = source.match(pattern);
      if (match) {
        const text = match[1].replace(/\s+/g, " ").trim();
        if (text && !/^(百度网盘|百度云)$/.test(text)) return text;
      }
    }
    return "";
  }

  function parseSharePage(html) {
    const marker = "locals.mset(";
    const start = html.indexOf(marker);
    if (start < 0) {
      if (/share\/init|请输入提取码|提取码/.test(html)) {
        throw new BaiduPanError("分享需要提取码，或提取码不正确");
      }
      throw new BaiduPanError("无法解析分享页，链接可能已失效或百度页面结构已更新");
    }
    const jsonStart = start + marker.length;
    const end = html.indexOf("});", jsonStart);
    if (end < 0) throw new BaiduPanError("分享页数据不完整");
    let data;
    try {
      data = JSON.parse(html.slice(jsonStart, end + 1));
    } catch (error) {
      throw new BaiduPanError(`分享页数据解析失败：${error.message}`);
    }
    const files = Array.isArray(data.file_list) ? data.file_list : [];
    if (!data.shareid || !data.share_uk || files.length === 0) {
      throw new BaiduPanError("分享页没有可转存的文件，或分享已失效");
    }
    return {
      userId: data.share_uk,
      shareId: data.shareid,
      bdstoken: data.bdstoken,
      // `parent_path` arrives percent-encoded (e.g.
      // "%2Fsharelink1100208284303-297938749075651"). It is the prefix every
      // in-share path must be built from, so decode it before use — leaving it
      // encoded makes /share/list answer errno 2.
      shareRoot: decodePath(files[0].parent_path || "/"),
      directories: files
        .filter((item) => Number(item.isdir) === 1)
        .map((item) => ({ id: item.fs_id, name: item.server_filename, isDirectory: true })),
      files: files
        .filter((item) => Number(item.isdir) !== 1)
        .map((item) => ({ id: item.fs_id, name: item.server_filename, isDirectory: false }))
    };
  }

  class BaiduPanTransfer {
    constructor(options = {}) {
      this.fetch = options.fetch || globalThis.fetch.bind(globalThis);
      this.onProgress = options.onProgress || (() => {});
      this.rootUrl = options.rootUrl || ROOT_URL;
      this.batchSize = options.batchSize || 100;
      this.maxRetries = options.maxRetries ?? 12;
      this.maxDepth = options.maxDepth ?? 12;
      this.destination = normalizeDestination(options.destination || "");
      this.bdstoken = null;
      this.shareId = null;
      this.userId = null;
      this.randsk = "";
      // Cookie writer supplied by the host (GM_cookie / chrome.cookies). Baidu
      // gates /share/list on the BDCLND cookie, which a page script cannot set
      // on its own.
      this.writeCookie = options.writeCookie || null;
      this.shareRoot = "/";
      this.directories = [];
      this.files = [];
    }

    // Persist `randsk` as the BDCLND cookie so subsequent /share/* calls are
    // authorised. Returns false when the host provides no cookie writer, in
    // which case callers fall back to the `sekey` query parameter.
    async persistRandsk() {
      if (!this.randsk || !this.writeCookie) return false;
      try {
        await this.writeCookie("BDCLND", this.randsk, "/", ".baidu.com");
        return true;
      } catch (_) {
        try {
          await this.writeCookie("BDCLND", this.randsk, "/", "pan.baidu.com");
          return true;
        } catch (_) {
          return false;
        }
      }
    }

    // Password-protected shares issue a `randsk` from /share/verify. Baidu
    // echoes it back as the `BDCLND` cookie and accepts it as `sekey` on later
    // /share/* calls. It is already percent-encoded by Baidu, so it must be
    // passed through verbatim — double-encoding it breaks authorisation.
    //
    // Field note (verified against pan.baidu.com): /share/list rejects a
    // request with `{"errno":9019,"errmsg":"need verify"}` unless either the
    // `BDCLND` cookie or a valid `sekey` is present, so both are sent.
    shareAuthParams() {
      if (!this.randsk) return "";
      const raw = String(this.randsk).replace(/^"|"$/g, "");
      return `&sekey=${raw}`;
    }

    progress(message) {
      this.onProgress(String(message));
    }

    async request(path, options = {}) {
      const method = options.method || "GET";
      const query = options.query ? `?${options.query}` : "";
      const response = await this.fetch(`${this.rootUrl}${path}${query}`, {
        method,
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
        },
        // Baidu rejects share endpoints reached without a pan.baidu.com
        // referrer. Browsers forbid scripts from setting `Referer` directly,
        // so declare it through the fetch `referrer` option instead (a no-op
        // in the extension service worker, where the DNR rule covers it).
        referrer: `${this.rootUrl}/`,
        referrerPolicy: "strict-origin-when-cross-origin",
        body: options.body || undefined,
        credentials: "include"
      });
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (_) {
        data = text;
      }
      if (!response.ok) {
        throw new BaiduPanError(`网络请求失败：HTTP ${response.status}`, { response: data });
      }
      // Baidu answers HTML landing pages (e.g. "啊哦，链接出错了") instead of
      // JSON when a share API call is unauthorised. Surface that page text
      // rather than leaking raw markup into the progress log.
      if (typeof data === "string" && options.checkErrno) {
        const notice = extractPageNotice(data);
        throw new BaiduPanError(notice || "百度网盘返回了非预期内容，请确认分享链接与提取码", {
          response: data
        });
      }
      if (options.checkErrno && data && typeof data === "object" && Number(data.errno || 0) !== 0) {
        throw new BaiduPanError(this.describeErrno(data), {
          errno: Number(data.errno),
          response: data
        });
      }
      return data;
    }

    // Translate Baidu's terse errno into an actionable message.
    describeErrno(data) {
      const errno = Number(data.errno || 0);
      const fallback = data.show_msg || data.errmsg || `百度网盘错误 ${errno}`;
      const known = {
        9019: "分享需要重新验证提取码，请填写提取码后重试",
        "-9": "提取码错误，请核对后重试",
        "-12": "分享的文件数超过转存上限",
        12: "批量操作失败，文件数可能超过限制",
        105: "分享链接地址错误或已失效",
        2: "参数错误，请刷新百度网盘页面后重试",
        "-6": "百度网盘登录已过期，请重新登录后刷新页面",
        111: "请求过于频繁，已被百度网盘限流，请稍后重试",
        1504: "操作过于频繁，请稍后重试"
      };
      // Baidu sometimes answers with a throttling notice under an otherwise
      // unrecognised code; surface it with a retry hint instead of raw text.
      const isThrottle = /请求超时|请求过快|繁忙|频繁|稍后再试/.test(fallback);
      if (isThrottle) return `${fallback}（百度网盘限流，请等待几分钟后重试）`;
      return known[String(errno)] || fallback;
    }

    async getBdstoken() {
      if (this.bdstoken) return this.bdstoken;
      const data = await this.request("/api/gettemplatevariable", {
        query: `fields=${encodeURIComponent('["bdstoken"]')}`,
        checkErrno: true
      });
      this.bdstoken = data?.result?.bdstoken;
      if (!this.bdstoken) throw new BaiduPanError("未检测到百度网盘登录状态，请先登录");
      return this.bdstoken;
    }

    async verifyShare(shareKey, password) {
      await this.getBdstoken();
      const data = await this.request("/share/verify", {
        method: "POST",
        query: `surl=${encodeURIComponent(shareKey)}&bdstoken=${encodeURIComponent(this.bdstoken)}`,
        body: `pwd=${encodeURIComponent(password || "")}`,
        checkErrno: true
      });
      if (!data.randsk) throw new BaiduPanError("提取码验证失败");
      this.randsk = data.randsk;
      // Writing the BDCLND cookie is what actually unlocks /share/list; the
      // `sekey` parameter alone is not honoured for listing.
      await this.persistRandsk();
      return data.randsk;
    }

    async loadShare(input, password = "") {
      const shareKey = extractShareKey(input);
      if (!shareKey) throw new BaiduPanError("无法从输入内容中识别百度网盘分享链接");
      // Verify the extraction code first. Baidu hands back `randsk` here and
      // mirrors it into the BDCLND cookie; fetching the share page before that
      // can return an empty file_list, and the later /share/list call then
      // fails with errno 9019 ("need verify").
      if (password) await this.verifyShare(shareKey, password);
      const html = await this.request(`/s/1${shareKey}`);
      const data = parseSharePage(html);
      Object.assign(this, data);
      return data;
    }

    async listDestination(path) {
      return this.request("/api/list", {
        query: [
          "order=time", "desc=1", "showempty=0", "page=1", "num=1000",
          `dir=${encodePath(path)}`, `bdstoken=${encodeURIComponent(this.bdstoken)}`
        ].join("&"),
        checkErrno: true
      });
    }

    async createDirectory(path) {
      if (!path) return;
      try {
        await this.listDestination(path);
        return;
      } catch (error) {
        if (error.errno !== -9) throw error;
      }
      await this.request("/api/create", {
        method: "POST",
        query: `a=commit&bdstoken=${encodeURIComponent(this.bdstoken)}`,
        body: `path=${encodeURIComponent(path)}&isdir=1&block_list=[]`,
        checkErrno: true
      });
    }

    async transferIds(ids, destination, retry = 0) {
      const data = await this.request("/share/transfer", {
        method: "POST",
        query: [
          `shareid=${encodeURIComponent(this.shareId)}`,
          `from=${encodeURIComponent(this.userId)}`,
          "ondup=newcopy", "channel=chunlei",
          `bdstoken=${encodeURIComponent(this.bdstoken)}`
        ].join("&") + this.shareAuthParams(),
        body: `fsidlist=${encodeURIComponent(JSON.stringify(ids))}&path=${encodeURIComponent(destination || "/")}`
      });
      const errno = Number(data?.errno || 0);
      if (errno === 0) return data;
      if ((errno === 111 || errno === 1504) && retry < this.maxRetries) {
        const delay = errno === 111 ? Math.min(30000, 5000 * (retry + 1)) : 1500;
        this.progress(`请求过快，${Math.ceil(delay / 1000)} 秒后重试…`);
        await sleep(delay);
        return this.transferIds(ids, destination, retry + 1);
      }
      if (errno === 12) {
        const limit = data.target_file_nums_limit;
        const count = data.target_file_nums;
        // errno 12 is overloaded: it also fires for reasons unrelated to a
        // file-count ceiling (e.g. an empty or single-folder share). Only
        // claim "over the limit" when Baidu actually reports the numbers.
        if (limit || count) {
          throw new BaiduPanError(
            `目录超过单次转存限制（${count ?? "?"}/${limit ?? "?"} 个文件）`,
            { errno, response: data }
          );
        }
        throw new BaiduPanError(
          data?.show_msg || data?.errmsg || "百度网盘拒绝了本次转存（该目录可能为空或不允许转存）",
          { errno, response: data }
        );
      }
      throw new BaiduPanError(data?.show_msg || data?.errmsg || `百度网盘转存错误 ${errno}`, {
        errno,
        response: data
      });
    }

    async transferFiles(files, destination) {
      await this.createDirectory(destination);
      for (let index = 0; index < files.length; index += this.batchSize) {
        const batch = files.slice(index, index + this.batchSize);
        await this.transferIds(batch.map((item) => item.id), destination);
        this.progress(`已转存 ${Math.min(index + batch.length, files.length)}/${files.length} 个文件到 ${destination || "/"}`);
      }
    }

    async listShareDirectory(path) {
      const result = [];
      for (let page = 1; ; page += 1) {
        const data = await this.request("/share/list", {
          // Field note (verified against pan.baidu.com): do NOT send `root=1`.
          // With `root=1` Baidu resolves `dir` from the *account* root and
          // answers with the requested folder itself (e.g. asking for
          // `.../9.16` returns `9.16`), which makes the recursive splitter loop
          // until it times out. Omitting it — or sending `root=0` — makes
          // `dir` resolve inside the share and returns the real children.
          query: [
            `uk=${encodeURIComponent(this.userId)}`,
            `shareid=${encodeURIComponent(this.shareId)}`,
            "order=name", "desc=0", "showempty=0",
            `page=${page}`, "num=100", `dir=${encodePath(path)}`
          ].join("&") + this.shareAuthParams(),
          checkErrno: true
        });
        const list = Array.isArray(data.list) ? data.list : [];
        for (const item of list) {
          result.push({
            id: item.fs_id,
            name: item.server_filename,
            isDirectory: Number(item.isdir) === 1
          });
        }
        if (list.length < 100) return result;
      }
    }

    async transferDirectories(directories, destination, relativePath = "", depth = 0) {
      if (!directories.length) return;
      await this.createDirectory(destination);
      try {
        await this.transferIds(directories.map((item) => item.id), destination);
        for (const item of directories) {
          this.progress(`已转存目录 ${destination || ""}/${item.name}`);
        }
        return;
      } catch (error) {
        if (error.errno !== 12) throw error;
      }

      this.progress(`目录数量超过限制，正在拆分处理：${directories.map((item) => item.name).join("、")}`);

      // A directory tree can exceed the per-transfer limit at any level. Split
      // a sibling set by halving it, but never recurse without bound: a share
      // whose root is itself a single folder keeps answering /share/list with
      // that same folder, which would otherwise loop forever.
      if (directories.length > 1) {
        const middle = Math.floor(directories.length / 2);
        await this.transferDirectories(directories.slice(0, middle), destination, relativePath, depth);
        await this.transferDirectories(directories.slice(middle), destination, relativePath, depth);
        return;
      }

      const directory = directories[0];
      if (depth >= this.maxDepth) {
        throw new BaiduPanError(
          `目录「${directory.name}」层级过深（已递归 ${depth} 层），无法继续拆分。` +
          `该分享可能不允许展开子目录，建议改为保存到网盘后手动整理。`,
          { errno: 12 }
        );
      }

      const sourcePath = `${relativePath}/${directory.name}`.replace(/\/{2,}/g, "/");
      const children = await this.listShareDirectory(`${this.shareRoot}${sourcePath}`.replace(/\/{2,}/g, "/"));

      // Guard against a share whose listing ignores `dir` and keeps returning
      // the very folder we asked about. Without this the same folder is
      // re-transferred indefinitely.
      const selfReferential = children.length > 0 && children.every(
        (item) => item.isDirectory && (item.id === directory.id || item.name === directory.name)
      );
      if (selfReferential) {
        throw new BaiduPanError(
          `无法拆分「${directory.name}」：百度网盘未提供该目录的内部列表，` +
          `说明这个分享本身就不允许展开子目录（常见于只分享单个文件夹、且该文件夹为空的情况）。` +
          `这种情况无法通过拆分解决——请直接用百度网盘网页端「保存到网盘」完成转存。`,
          { errno: 12 }
        );
      }

      const childDestination = `${destination}/${directory.name}`.replace(/\/{2,}/g, "/");
      const childDirectories = children.filter((item) => item.isDirectory);
      const childFiles = children.filter((item) => !item.isDirectory);
      await this.createDirectory(childDestination);
      if (childDirectories.length) {
        await this.transferDirectories(childDirectories, childDestination, sourcePath, depth + 1);
      }
      if (childFiles.length) await this.transferFiles(childFiles, childDestination);
    }

    async run(input, password = "") {
      this.progress("正在读取分享信息…");
      await this.loadShare(input, password);
      this.progress(`发现 ${this.directories.length} 个目录、${this.files.length} 个文件`);
      if (this.directories.length) await this.transferDirectories(this.directories, this.destination);
      if (this.files.length) await this.transferFiles(this.files, this.destination);
      this.progress("全部转存完成");
      return { directories: this.directories.length, files: this.files.length, destination: this.destination || "/" };
    }
  }

  return {
    BaiduPanError,
    BaiduPanTransfer,
    extractShareKey,
    normalizeDestination,
    parseSharePage,
    encodePath,
    decodePath,
    extractPageNotice,
    stripBdclnd,
    appendBdclnd
  };
});

"use strict";

const hasBrowserNamespace = typeof globalThis.browser !== "undefined";
const ext = globalThis.browser || globalThis.chrome;
const { BaiduPanTransfer } = globalThis.BaiduTransferCore;
let running = false;
let keepAliveTimer = null;

// A transfer can pause for up to 30s while waiting out a Baidu rate limit.
// A pending timer does not keep an MV3 service worker alive, so ping a
// lightweight extension API periodically to reset the idle-termination timer.
function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    call(ext.runtime, "getPlatformInfo").catch(() => {});
  }, 20000);
}

function stopKeepAlive() {
  if (!keepAliveTimer) return;
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

function call(api, method, ...args) {
  if (hasBrowserNamespace) return Promise.resolve(api[method](...args));
  return new Promise((resolve, reject) => {
    try {
      api[method](...args, (result) => {
        const error = globalThis.chrome.runtime.lastError;
        error ? reject(new Error(error.message)) : resolve(result);
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function setState(patch) {
  await call(ext.storage.local, "set", { transferState: { ...(await getState()), ...patch } });
}

async function getState() {
  const data = await call(ext.storage.local, "get", "transferState");
  return data?.transferState || {};
}

async function broadcast(message) {
  await call(ext.runtime, "sendMessage", message).catch(() => {});
}

async function report(message) {
  const state = await getState();
  const log = [...(state.log || []), { at: Date.now(), message }].slice(-80);
  await setState({ status: "running", message, log, updatedAt: Date.now() });
  await broadcast({ type: "TRANSFER_PROGRESS", message });
}

async function startTransfer({ url, password, destination }) {
  if (running) throw new Error("已有转存任务正在运行");
  running = true;
  startKeepAlive();
  let progressQueue = Promise.resolve();
  try {
    await setState({ status: "running", message: "准备开始…", log: [], startedAt: Date.now(), updatedAt: Date.now() });
    const transfer = new BaiduPanTransfer({
      destination,
      onProgress: (message) => { progressQueue = progressQueue.then(() => report(message)); }
    });
    const result = await transfer.run(url, password);
    await progressQueue;
    await setState({ status: "complete", message: "全部转存完成", result, updatedAt: Date.now() });
    await broadcast({ type: "TRANSFER_COMPLETE", result });
  } catch (error) {
    await progressQueue.catch(() => {});
    await setState({ status: "error", message: error.message, error: error.message, updatedAt: Date.now() });
    await broadcast({ type: "TRANSFER_ERROR", error: error.message });
  } finally {
    running = false;
    stopKeepAlive();
  }
}

async function ensureNetRules() {
  if (!ext.declarativeNetRequest?.updateDynamicRules) return;
  const base = {
    id: 1,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "Origin", operation: "set", value: "https://pan.baidu.com" },
        { header: "Referer", operation: "set", value: "https://pan.baidu.com/disk/main?from=homeFlow" },
        { header: "Sec-Fetch-Site", operation: "set", value: "same-origin" }
      ]
    },
    condition: {
      urlFilter: "||pan.baidu.com/",
      requestDomains: ["pan.baidu.com"],
      resourceTypes: ["xmlhttprequest"]
    }
  };
  try {
    await ext.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1],
      addRules: [{ ...base, condition: { ...base.condition, initiatorDomains: [ext.runtime.id] } }]
    });
  } catch (_) {
    await ext.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1], addRules: [base] });
  }
}

ext.runtime.onInstalled.addListener(() => ensureNetRules().catch(console.error));
ext.runtime.onStartup?.addListener(() => ensureNetRules().catch(console.error));
ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "START_TRANSFER") {
    if (running) {
      const response = { ok: false, error: "已有转存任务正在运行" };
      if (hasBrowserNamespace) return Promise.resolve(response);
      sendResponse(response);
      return false;
    }
    void startTransfer(message.payload);
    const response = { ok: true };
    if (hasBrowserNamespace) return Promise.resolve(response);
    sendResponse(response);
    return false;
  }
  if (message?.type === "GET_STATE") {
    const promise = getState().then(
      (state) => ({ ok: true, state }),
      (error) => ({ ok: false, error: error.message })
    );
    if (hasBrowserNamespace) return promise;
    promise.then(sendResponse);
    return true;
  }
  return false;
});

ensureNetRules().catch(console.error);
