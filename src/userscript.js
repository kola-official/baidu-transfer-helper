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
