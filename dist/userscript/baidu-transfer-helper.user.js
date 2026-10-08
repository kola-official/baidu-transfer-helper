// ==UserScript==
// @name         百度网盘批量转存助手（跨浏览器版）
// @namespace    https://github.com/kola-official/baidu-transfer-helper
// @version      1.0.2
// @description  自动递归拆分并转存超过数量限制的百度网盘分享目录
// @match        https://pan.baidu.com/*
// @grant        GM.cookie
// @grant        GM_cookie
// @run-at       document-idle
// ==/UserScript==

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


(function () {
  "use strict";
  if (window.top !== window.self || document.getElementById("bpth-launcher")) return;
  const { BaiduPanTransfer } = globalThis.BaiduTransferCore;
  const STORAGE_KEY = "bpth-form-v1";
  let running = false;

  // Baidu authorises share listing through the BDCLND cookie, which a page
  // script cannot set directly. Tampermonkey / Violentmonkey expose GM_cookie
  // for exactly this; when it is unavailable the transfer falls back to the
  // `sekey` query parameter (which works for some shares but not all).
  const gmCookie = (() => {
    const api = (typeof GM_cookie !== "undefined" && GM_cookie)
      || (typeof GM !== "undefined" && GM && GM.cookie)
      || null;
    return api && typeof api.set === "function" ? api : null;
  })();

  function writeCookie(name, value, path, domain) {
    if (!gmCookie) {
      return Promise.reject(new Error("GM_cookie 不可用"));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (error) => {
        if (settled) return;
        settled = true;
        error ? reject(error) : resolve();
      };
      try {
        // Tampermonkey's GM_cookie.set is callback-based; Violentmonkey's
        // GM.cookie.set returns a promise. Support both.
        if (gmCookie.set.length >= 2) {
          gmCookie.set({ name, value, path, domain }, (error) => done(error || undefined));
        } else {
          const result = gmCookie.set({ name, value, path, domain });
          if (result && typeof result.then === "function") result.then(() => done(), done);
          else done();
        }
        // Never let a non-reporting host hang the whole transfer.
        setTimeout(() => done(), 500);
      } catch (error) {
        done(error);
      }
    });
  }

  const style = document.createElement("style");
  style.textContent = `
    #bpth-launcher{position:fixed;right:22px;bottom:92px;z-index:2147483646;width:52px;height:52px;border:0;border-radius:50%;background:linear-gradient(135deg,#2878ff,#74a9ff);color:#fff;font:700 15px/1 sans-serif;box-shadow:0 10px 28px #1c5fdc66;cursor:pointer}
    #bpth-panel{all:initial;position:fixed;right:22px;bottom:155px;z-index:2147483647;width:390px;box-sizing:border-box;padding:18px;border:1px solid #d9e1ed;border-radius:15px;background:#f7f9fc;color:#172033;box-shadow:0 18px 55px #15244744;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}
    #bpth-panel *{box-sizing:border-box}#bpth-panel[hidden]{display:none}#bpth-panel h2{margin:0 28px 4px 0;font-size:17px}#bpth-panel .sub{margin:0 0 13px;color:#6b768a;font-size:12px}#bpth-close{position:absolute;right:12px;top:10px;border:0;background:transparent;color:#647087;font-size:23px;cursor:pointer}
    #bpth-panel label{display:block;margin:10px 0 5px;color:#344057;font-size:12px;font-weight:700}#bpth-panel textarea,#bpth-panel input{display:block;width:100%;margin-top:5px;border:1px solid #cdd6e4;border-radius:8px;padding:9px 10px;background:#fff;color:#172033;font:12px/1.45 inherit;outline:none;resize:vertical}#bpth-panel textarea:focus,#bpth-panel input:focus{border-color:#2878ff;box-shadow:0 0 0 3px #2878ff18}
    #bpth-panel .row{display:grid;grid-template-columns:1fr 1.5fr;gap:9px}#bpth-start{width:100%;margin-top:13px;border:0;border-radius:9px;padding:11px;background:#2878ff;color:#fff;font:700 13px/1 inherit;cursor:pointer}#bpth-start:disabled{background:#9bacbf;cursor:not-allowed}#bpth-status{margin-top:11px;max-height:150px;overflow:auto;border:1px solid #dce3ed;border-radius:8px;padding:9px;background:#fff;color:#536178;font:12px/1.55 inherit;white-space:pre-wrap}#bpth-status:empty{display:none}
  `;
  document.documentElement.appendChild(style);

  const launcher = document.createElement("button");
  launcher.id = "bpth-launcher";
  launcher.type = "button";
  launcher.textContent = "批存";
  launcher.title = "百度网盘批量转存";

  const panel = document.createElement("section");
  panel.id = "bpth-panel";
  panel.hidden = true;
  panel.innerHTML = `
    <button id="bpth-close" type="button" aria-label="关闭">×</button>
    <h2>百度网盘批量转存</h2><p class="sub">自动递归拆分超过数量限制的分享目录</p>
    <label>分享链接<textarea id="bpth-url" rows="3" placeholder="https://pan.baidu.com/s/1..."></textarea></label>
    <div class="row"><label>提取码<input id="bpth-password" maxlength="8" placeholder="可留空"></label><label>保存目录<input id="bpth-destination" placeholder="/ 或 /资料"></label></div>
    <button id="bpth-start" type="button">开始转存</button><div id="bpth-status"></div>
  `;
  document.documentElement.append(launcher, panel);

  const byId = (id) => panel.querySelector(`#${id}`);
  const urlInput = byId("bpth-url");
  const passwordInput = byId("bpth-password");
  const destinationInput = byId("bpth-destination");
  const startButton = byId("bpth-start");
  const status = byId("bpth-status");
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  urlInput.value = saved.url || (/\/s\/1/.test(location.href) ? location.href : "");
  passwordInput.value = saved.password || new URL(location.href).searchParams.get("pwd") || "";
  destinationInput.value = saved.destination || "";

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      url: urlInput.value.trim(), password: passwordInput.value.trim(), destination: destinationInput.value.trim()
    }));
  }
  function log(message) {
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    status.textContent += `${status.textContent ? "\n" : ""}[${time}] ${message}`;
    status.scrollTop = status.scrollHeight;
  }

  launcher.addEventListener("click", () => { panel.hidden = !panel.hidden; });
  byId("bpth-close").addEventListener("click", () => { panel.hidden = true; });
  for (const input of [urlInput, passwordInput, destinationInput]) input.addEventListener("change", save);
  startButton.addEventListener("click", async () => {
    if (running) return;
    if (!urlInput.value.trim()) return urlInput.focus();
    save();
    running = true;
    startButton.disabled = true;
    startButton.textContent = "正在转存…";
    status.textContent = "";
    try {
      const transfer = new BaiduPanTransfer({
        destination: destinationInput.value,
        onProgress: log,
        writeCookie
      });
      await transfer.run(urlInput.value, passwordInput.value);
      log("✅ 转存成功，请刷新百度网盘文件列表");
      urlInput.value = "";
      passwordInput.value = "";
      save();
    } catch (error) {
      console.error("[百度网盘批量转存]", error);
      log(`❌ ${error.message}`);
    } finally {
      running = false;
      startButton.disabled = false;
      startButton.textContent = "开始转存";
    }
  });
})();
