// ==UserScript==
// @name         智慧树新形态课程 · 学习资源逐个打开
// @namespace    local.zhihuishu.resource-opener
// @version      1.2.2
// @description  逐个打开学习资源并正常播放视频，支持刷新接续、暂停、完成状态检查和日志导出。
// @match        https://ai-smart-course-student-pro.zhihuishu.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  const PANEL_ID = 'zhs-resource-opener-v1';
  if (document.getElementById(PANEL_ID)) return;
  const S = {
    point: '.section-item-collapse .section-item-collapse-info',
    pointName: '.section-item-collapse-title .title-text',
    heading: '#middle-section-id .point-title-text',
    section: '#middle-section-id .resources-section',
    card: '.basic-info-video-card-container',
    title: 'h5.video-title',
    preview: '#middle-section-id .preview-content',
  };
  const text = el => (el?.textContent || '').replace(/\s+/g, ' ').trim();
  const all = (selector, root = document) => [...root.querySelectorAll(selector)];
  const visible = el => !!el && el.getClientRects().length > 0 &&
    getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const pauseError = () => new DOMException('已暂停', 'AbortError');
  let busy = false;
  let controller;
  let records = {};
  let recordKey = '';
  let expectedPath = '';
  let runCourse = '';
  let navigating = false;
  let rows = [];
  let messages = [];
  let runState = null;
  let documentLeaving = false;
  let activeVideo = null;

  function route() {
    const match = location.pathname.match(/^\/learnPage\/([^/]+)\/([^/]+)\/([^/]+)\/?$/);
    return match ? { course: `${match[1]}:${match[3]}`, point: match[2] } : null;
  }

  function loadRecords() {
    const current = route();
    if (!current) throw new Error('请先进入任意知识点的学习资源页面（网址含 /learnPage/）。');
    const key = `zhs-resource-opener:v1:${current.course}`;
    if (recordKey !== key) {
      const saved = sessionStorage.getItem(key);
      records = saved ? JSON.parse(saved) : {};
      if (!records || typeof records !== 'object' || Array.isArray(records)) {
        throw new Error('访问记录格式异常，请清空本次访问记录后重试。');
      }
      recordKey = key;
      const savedLogs = JSON.parse(sessionStorage.getItem(`${key}:logs`) || '[]');
      messages = Array.isArray(savedLogs) ? savedLogs.filter(m => typeof m === 'string').slice(-80) : [];
      renderLogs();
    }
  }

  function saveRecords() {
    sessionStorage.setItem(recordKey, JSON.stringify(records));
  }

  function saveRun() {
    if (runState) sessionStorage.setItem(`${recordKey}:run`, JSON.stringify(runState));
  }

  function pause() {
    if (!busy) return;
    // 在中断异步操作之前同步保存，避免此时发生页面跳转又恢复运行。
    if (runState) { runState.status = 'paused'; saveRun(); }
    controller?.abort();
    stopVideo();
  }

  function stopVideo() {
    // 网站可能在卡片打开后立即自动播放，而监控循环还在等待页面稳定。
    if (!activeVideo && runState?.pending?.video) {
      const selected = resources().find(r => r.video && r.node.classList.contains('active'));
      if (selected && JSON.stringify([route()?.point, selected.key]) === runState.pending.key) {
        activeVideo = all('#middle-section-id .video-player-wrapper video').find(visible) || null;
      }
    }
    if (activeVideo && !activeVideo.paused) activeVideo.pause();
  }

  function checkpoint() {
    if (controller?.signal.aborted) throw pauseError();
    if (route()?.course !== runCourse) throw new Error('已离开当前课程，停止打开资源。');
    if (!navigating && location.pathname !== expectedPath) {
      throw new Error('检测到手动切换知识点，已停止；请重新扫描后继续。');
    }
    const dialog = all('[role="dialog"], .el-message-box, .el-overlay-dialog').find(visible);
    if (dialog) throw new Error(activeVideo ? '检测到视频弹题或网站弹窗，已暂停视频。处理完成后点击“开始 / 继续”。' : '检测到网站弹窗，已停止。处理弹窗后可继续。');
  }

  async function delay(ms) {
    const end = Date.now() + ms;
    do {
      checkpoint();
      await new Promise(resolve => setTimeout(resolve, Math.min(150, Math.max(1, end - Date.now()))));
    } while (Date.now() < end);
    checkpoint();
  }

  async function waitFor(test, description, timeout = 25000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      checkpoint();
      const result = test();
      if (result) return result;
      await delay(150);
    }
    throw new Error(`等待超时：${description}。请检查页面后继续，或增加停留时间。`);
  }

  // 用模块、单元、知识点名称组成键；不用 DOM 自动生成的 el-id，也不把长 ID 转成 Number。
  function points() {
    const occurrences = new Map();
    return all(S.point).map(node => {
      const name = text(node.querySelector(S.pointName));
      const parents = [];
      for (let p = node.parentElement; p; p = p.parentElement) {
        if (p.classList.contains('el-collapse-item')) {
          const header = [...p.children].find(c => c.classList.contains('el-collapse-item__header'));
          if (header) parents.unshift(text(header.querySelector('.title-text p')) || text(header));
        }
      }
      const base = JSON.stringify([...parents, name]);
      const occurrence = occurrences.get(base) || 0;
      occurrences.set(base, occurrence + 1);
      return { key: `${base}:${occurrence}`, name, node };
    }).filter(item => item.name);
  }

  function resources() {
    const occurrences = new Map();
    return all(S.section).flatMap(section => {
      const group = text(section.querySelector('.resources-detail-title'));
      return all(S.card, section).map(node => {
        const title = text(node.querySelector(S.title));
        const duration = all('.page-num', node).some(e => /^\d+:\d{2}(?::\d{2})?$/.test(text(e)));
        const audio = !!node.querySelector('.icon-box.audio');
        const video = !audio && (!!node.querySelector('.icon-box.video') || duration);
        const media = video || audio;
        const base = JSON.stringify([group, title]);
        const index = occurrences.get(base) || 0;
        occurrences.set(base, index + 1);
        const status = text(node.querySelector('.finished-icon'));
        return { key: `${base}:${index}`, title, group, media, video, audio, node,
          finished: status.includes('已完成') || (video && /^100(?:\.0+)?\s*%$/.test(status)) };
      });
    }).filter(item => item.title);
  }

  function resourceListReady() {
    const sections = all(S.section);
    if (!sections.length) return false;
    return sections.every(section => {
      const tag = all('.tag', section).find(e => /^全部\s*·/.test(text(e)));
      const amount = tag?.querySelector('.tag-num');
      const count = Number(text(amount));
      return !!amount && Number.isInteger(count) && count >= 0 &&
        all(S.card, section).length === count && all(S.card, section).every(e => text(e.querySelector(S.title)));
    });
  }

  async function stableResources() {
    await waitFor(() => all(S.section).length, '资源区域出现');
    for (const section of all(S.section)) {
      const tag = all('.tag', section).find(e => /^全部\s*·/.test(text(e)));
      if (tag && !tag.classList.contains('tag-active')) { tag.click(); await delay(300); }
    }
    let signature = '';
    let since = Date.now();
    await waitFor(() => {
      const next = JSON.stringify(resources().map(r => r.key));
      if (!resourceListReady() || next !== signature || loading()) {
        signature = next;
        since = Date.now();
        return false;
      }
      return Date.now() - since >= 1500;
    }, '完整资源列表加载并稳定');
    return resources();
  }

  function loading() {
    return all('#middle-section-id .el-loading-mask, #middle-section-id [aria-busy="true"]').some(visible);
  }

  function previewReady() {
    const preview = document.querySelector(S.preview);
    if (!preview || loading()) return false;
    const content = [...preview.children].filter(visible).filter(e => !e.classList.contains('empty-previewType'));
    return content.some(e => text(e).length > 0 ||
      all('canvas, iframe, object, embed', e).some(visible) ||
      all('img', e).some(img => visible(img) && img.complete && img.naturalWidth > 0));
  }

  function videoTime(seconds) {
    if (!Number.isFinite(seconds)) return '--:--';
    const s = Math.max(0, Math.floor(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function assertSelected(resource) {
    if (!resources().find(r => r.key === resource.key)?.node.classList.contains('active')) {
      throw new Error('资源被切换，已停止视频任务。');
    }
  }

  async function playVideo(resource, settings) {
    let video;
    let endedObserved = false;
    let endReason = 'ended';
    const onEnded = () => { endedObserved = true; };
    try {
      video = await waitFor(() => all('#middle-section-id .video-player-wrapper video').find(visible),
        'HTML5 视频播放器出现（跨域嵌入播放器暂不支持）', 40000);
      activeVideo = video;
      video.addEventListener('ended', onEnded);
      await waitFor(() => {
        if (video.error) throw new Error(`视频加载失败（错误码 ${video.error.code}），请检查网络后继续。`);
        return video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 0;
      }, '视频时长和播放信息加载', 40000);
      assertSelected(resource);
      const source = video.currentSrc || video.getAttribute('src');
      // 播放进度交给网站恢复；不修改 currentTime，不伪造 ended 或学习上报。
      video.muted = !!settings.muted;
      video.playbackRate = 1;
      if (video.paused && !video.ended) {
        let resolved = false;
        let rejection = null;
        try {
          Promise.resolve(video.play()).then(() => { resolved = true; }, error => { rejection = error; });
        } catch (error) { rejection = error; }
        await waitFor(() => {
          if (rejection) throw new Error(`浏览器未允许播放视频（${rejection.name || '播放失败'}）。请手动点击播放器播放，再点脚本“开始 / 继续”。`);
          return resolved || !video.paused;
        }, '视频开始播放；如被拦截请手动点击播放', 15000);
      }
      log(`正在播放视频：${resource.title}（${videoTime(video.currentTime)} / ${videoTime(video.duration)}）`);
      let previousTime = video.currentTime;
      let progressedAt = Date.now();
      let savedAt = 0;
      let loggedAt = Date.now();
      let pausedAt = null;
      while (true) {
        checkpoint();
        assertSelected(resource);
        if (!video.isConnected || !visible(video) || (video.currentSrc || video.getAttribute('src')) !== source) {
          throw new Error('播放器或视频源发生变化，已停止；请确认当前资源后继续。');
        }
        if (video.error) throw new Error(`视频播放失败（错误码 ${video.error.code}），请检查网络后继续。`);
        const now = Date.now();
        if (now - savedAt >= 5000 || video.ended || endedObserved) {
          runState.pending.videoProgress = { currentTime: video.currentTime, duration: video.duration,
            ended: video.ended || endedObserved, time: new Date().toISOString() };
          saveRun();
          savedAt = now;
        }
        ui.status.textContent = `视频：${resource.title} · ${videoTime(video.currentTime)} / ${videoTime(video.duration)}`;
        if (video.ended || endedObserved) break;
        if (video.paused) {
          // pause 可能先于 ended 更新；保留结束事件，兼容播放器随后重置 ended。
          pausedAt ??= now;
          if (now - pausedAt < 3000) {
            await delay(250);
            continue;
          }
          const remaining = video.duration - video.currentTime;
          if (Number.isFinite(remaining) && remaining >= 0 && remaining <= 1) {
            endReason = 'near-end-pause';
            runState.pending.videoProgress = { currentTime: video.currentTime, duration: video.duration,
              ended: false, endReason, time: new Date().toISOString() };
            saveRun();
            break;
          }
          throw new Error('播放器中途暂停，可能有弹题或需要手动操作。请检查视频区域，完成后点击“开始 / 继续”；当前视频不会记为完成。');
        }
        pausedAt = null;
        if (Math.abs(video.currentTime - previousTime) > 0.05) {
          previousTime = video.currentTime;
          progressedAt = now;
        } else if (now - progressedAt >= 60000) {
          throw new Error('视频已连续 60 秒没有播放进展，已停止；请检查缓冲或网络后继续。');
        }
        if (now - loggedAt >= 30000) {
          log(`视频播放进度：${videoTime(video.currentTime)} / ${videoTime(video.duration)} · ${resource.title}`);
          loggedAt = now;
        }
        await delay(500);
      }
      log(`${endReason === 'ended' ? '视频已播完' : '视频在末尾暂停，尚未确认完成'}，等待网站更新完成标记：${resource.title}`);
      const confirmUntil = Date.now() + 15000;
      while (!resources().find(r => r.key === resource.key)?.finished && Date.now() < confirmUntil) {
        checkpoint();
        assertSelected(resource);
        await delay(500);
      }
      if (!resources().find(r => r.key === resource.key)?.finished) {
        // 现场观察到视频结束后卡片仍显示旧进度，刷新后才出现“已完成”。
        runState.pending.completionRefresh = true;
        saveRun();
        log(`视频结束状态待核对，卡片进度未更新；刷新一次核对网站完成状态：${resource.title}`);
        location.reload();
        await waitFor(() => false, '刷新页面核对视频进度；若刷新被阻止，请手动刷新', 15000);
      }
      return { duration: video.duration, completion: `${endReason}-and-site-confirmed` };
    } finally {
      video?.removeEventListener('ended', onEnded);
      stopVideo();
      activeVideo = null;
    }
  }

  async function openPoint(item) {
    const current = points().find(p => p.key === item.key);
    if (!current) throw new Error(`目录中已找不到知识点：${item.name}`);
    const wrappers = [];
    for (let p = current.node.parentElement; p; p = p.parentElement) {
      if (p.classList.contains('el-collapse-item')) wrappers.unshift(p);
    }
    for (const wrapper of wrappers) {
      checkpoint();
      const header = [...wrapper.children].find(c => c.classList.contains('el-collapse-item__header'));
      if (header?.getAttribute('aria-expanded') === 'false') {
        header.click();
        await waitFor(() => header.getAttribute('aria-expanded') === 'true', '展开知识点目录');
        await delay(200);
      }
    }
    const node = points().find(p => p.key === item.key)?.node;
    if (!visible(node)) throw new Error(`知识点目录未展开：${item.name}`);
    if (!node.classList.contains('active') || text(document.querySelector(S.heading)) !== item.name) {
      const oldPath = location.pathname;
      const attempts = runState.pending?.kind === 'point' && runState.pending.key === item.key
        ? runState.pending.attempts : 0;
      if (attempts >= 2) throw new Error(`知识点跳转后仍未到达目标，已停止重复跳转：${item.name}`);
      runState.pending = { kind: 'point', key: item.key, attempts: attempts + 1 };
      saveRun();
      log(`正在进入知识点：${item.name}；如果页面刷新，将自动继续。`);
      navigating = true;
      try {
        node.click();
        await waitFor(() => location.pathname !== oldPath &&
          text(document.querySelector(S.heading)) === item.name &&
          points().find(p => p.key === item.key)?.node.classList.contains('active'), '切换知识点');
      } finally {
        navigating = false;
        expectedPath = location.pathname;
      }
      await delay(1200);
    }
    runState.pointId = route().point;
    if (runState.pending?.kind === 'point') runState.pending = null;
    saveRun();
    return stableResources();
  }

  function renderLogs() {
    ui.log.textContent = messages.join('\n') || '暂无运行日志。点击“开始 / 继续”后，日志会显示在这里。';
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  function log(message) {
    messages.push(`${new Date().toLocaleTimeString()} ${message}`);
    messages = messages.slice(-80);
    renderLogs();
    // 日志保存失败不覆盖原始错误；任务状态保存失败则由主循环停止处理。
    try {
      if (recordKey) sessionStorage.setItem(`${recordKey}:logs`, JSON.stringify(messages));
    } catch { ui.log.textContent += '\n日志存储不可用，刷新后可能无法保留。'; }
  }

  function summary() {
    const entries = Object.values(records);
    const visited = entries.filter(r => ['visited', 'video-complete'].includes(r.status)).length;
    const confirmed = entries.filter(r => ['visited', 'video-complete'].includes(r.status) && r.siteFinished).length;
    const videos = entries.filter(r => r.status === 'video-complete').length;
    const skipped = entries.filter(r => r.status === 'skipped-media').length;
    ui.stats.textContent = `本标签页记录：已访问 ${visited} · 网站已完成 ${confirmed} · 视频完成 ${videos} · 跳过音视频 ${skipped}`;
  }

  function scan() {
    loadRecords();
    rows = points();
    if (!rows.length) throw new Error('未识别到知识点目录；当前页面结构可能已变化。');
    const current = resources();
    ui.status.textContent = `已识别 ${rows.length} 个知识点；当前资源 ${current.length} 个（音视频 ${current.filter(r => r.media).length} 个）。`;
    summary();
    log('目录扫描完成。运行期间刷新会自动接续；暂停后刷新保持暂停。');
  }

  async function runQueue(restored) {
    runCourse = route()?.course;
    expectedPath = location.pathname;
    if (!runCourse) throw new Error('请先进入任意知识点的学习资源页面。');
    loadRecords();
    await waitFor(() => points().some(p => p.node.classList.contains('active')) &&
      text(document.querySelector(S.heading)), '知识点页面初始化', 45000);
    scan();
    const settings = restored?.settings || {
      scope: ui.scope.value, seconds: Number(ui.seconds.value), onlyNew: ui.onlyNew.checked,
      videos: ui.videos.checked, muted: ui.muted.checked,
      randomDwell: ui.randomDwell.checked,
    };
    const queue = restored?.queue || (settings.scope === 'current'
      ? rows.filter(p => p.node.classList.contains('active')) : rows).map(({ key, name }) => ({ key, name }));
    if (!queue.length) throw new Error('没有找到当前选中的知识点。');
    const seconds = settings.seconds;
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 60) throw new Error('固定停留时间应为 1～60 秒。');
    if (restored) {
      const activeKey = rows.find(p => p.node.classList.contains('active'))?.key;
      const atTarget = activeKey === queue[restored.index]?.key;
      const atPrevious = restored.pending?.kind === 'point' && route().point === restored.pointId;
      if (restored.course !== runCourse || (!atTarget && !atPrevious)) {
        throw new Error('刷新后所在知识点与保存的任务不一致，已停止；请手动点击开始。');
      }
      runState = restored;
      log(`页面已重新加载，自动接续知识点 ${restored.index + 1}/${queue.length}，保留此前访问进度。`);
    } else {
      runState = { version: 1, course: runCourse, status: 'running', queue, index: 0,
        settings, pointId: route().point, doneResources: [], pending: null };
    }
    saveRun();
    const onlyNew = settings.onlyNew;
    for (let p = runState.index; p < queue.length; p++) {
      checkpoint();
      const point = queue[p];
      runState.index = p;
      saveRun();
      ui.status.textContent = `知识点 ${p + 1}/${queue.length}：${point.name}`;
      const list = await openPoint(point);
      const pointId = route().point;
      for (let i = 0; i < list.length; i++) {
        checkpoint();
        const resource = list[i];
        const key = JSON.stringify([pointId, resource.key]);
        // 本轮游标独立于历史记录，即使取消“跳过已访问”，刷新也不会重放已处理的资源。
        if (runState.doneResources.includes(key)) continue;
        if (resource.audio || (resource.video && !settings.videos)) {
          records[key] = { point: point.name, title: resource.title, group: resource.group,
            status: 'skipped-media', time: new Date().toISOString() };
          saveRecords(); summary();
          log(`跳过音视频：${resource.title}`);
          continue;
        }
        if (resource.video && resource.finished) {
          records[key] = { point: point.name, title: resource.title, group: resource.group,
            status: 'video-complete', siteFinished: true, completion: 'site-already-complete', time: new Date().toISOString() };
          runState.doneResources.push(key); runState.pending = null;
          saveRecords(); saveRun(); summary();
          log(`网站已标记视频完成，跳过重复播放：${resource.title}`);
          continue;
        }
        if (resource.video && runState.pending?.key === key && runState.pending.completionRefresh) {
          throw new Error(`视频结束状态已刷新核对，但网站仍未显示完成：${resource.title}。已停止，请检查平台进度或未完成的题目。`);
        }
        if (!resource.video && onlyNew && records[key]?.status === 'visited') continue;
        ui.status.textContent = `${p + 1}/${queue.length} ${point.name} · 资源 ${i + 1}/${list.length}：${resource.title}`;
        const fresh = resources().find(r => r.key === resource.key);
        if (!fresh || !visible(fresh.node)) throw new Error(`资源卡片不可用：${resource.title}`);
        const pending = runState.pending?.kind === 'resource' && runState.pending.key === key
          ? runState.pending : null;
        // 每项图文单独抽取 1～5 秒；在点击前保存，整页跳转后沿用同一次抽取。
        const dwellSeconds = resource.video ? seconds : pending?.dwellSeconds ??
          (settings.randomDwell ? 1 + Math.floor(Math.random() * 5) : seconds);
        // 卡片点击引起整页加载后，先验证已选中的资源，避免再次点击造成刷新循环。
        const keepCurrentVideo = resource.video && fresh.node.classList.contains('active');
        if ((!pending && !keepCurrentVideo) || !fresh.node.classList.contains('active')) {
          const attempts = pending?.attempts || 0;
          if (attempts >= 2) throw new Error(`资源打开后未保持选中，已停止重复刷新：${resource.title}`);
          runState.pending = { kind: 'resource', key, attempts: attempts + 1, video: resource.video, dwellSeconds };
          saveRun();
          log(`正在打开资源：${resource.title}`);
          fresh.node.click();
        } else {
          if (!pending) {
            runState.pending = { kind: 'resource', key, attempts: 0, video: resource.video, dwellSeconds };
            saveRun();
          }
          log(`接续当前已打开的资源：${resource.title}`);
        }
        runState.pending.dwellSeconds = dwellSeconds;
        saveRun();
        await waitFor(() => resources().find(r => r.key === resource.key)?.node.classList.contains('active'), '选中资源');
        if (!resource.video) log(`图文停留 ${dwellSeconds} 秒（${settings.randomDwell ? '随机' : '固定'}）：${resource.title}`);
        await delay(dwellSeconds * 1000);
        const videoResult = resource.video ? await playVideo(resource, settings) : null;
        if (!resource.video) await waitFor(previewReady, '资源预览显示');
        checkpoint();
        const after = resources().find(r => r.key === resource.key);
        if (!after?.node.classList.contains('active')) throw new Error('资源被切换，已停止记录。');
        records[key] = { point: point.name, title: resource.title, group: resource.group,
          status: resource.video ? 'video-complete' : 'visited', siteFinished: after.finished,
          ...(!resource.video ? { dwellSeconds } : {}),
          ...(videoResult || {}), time: new Date().toISOString() };
        saveRecords(); summary();
        runState.doneResources.push(key);
        runState.pending = null;
        saveRun();
        log(`${after.finished ? '网站已完成' : '已访问，网站尚未显示完成'}：${resource.title}`);
      }
      // 在下一个知识点被点击前，持久化目标位置；新页面不会从队首跳回去。
      runState.index = p + 1;
      runState.doneResources = [];
      runState.pending = p + 1 < queue.length ? { kind: 'point', key: queue[p + 1].key, attempts: 0 } : null;
      if (runState.index === queue.length) runState.status = 'complete';
      saveRun();
    }
    ui.status.textContent = settings.videos ? '本轮资源处理结束；视频已检查完成，音频已跳过。' : '本轮非视频资源访问结束；音视频已跳过。';
    log('本轮结束。可导出结果查看哪些资源尚未显示完成。');
  }

  async function start(restored = null) {
    if (busy) return;
    busy = true;
    controller = new AbortController();
    runState = restored;
    ui.start.disabled = true;
    ui.pause.disabled = false;
    for (const el of [ui.scan, ui.reset, ui.scope, ui.seconds, ui.randomDwell, ui.onlyNew, ui.videos, ui.muted]) el.disabled = true;
    try {
      // 同一浏览器同一课程只允许一个标签页运行；关闭标签页后浏览器自动释放锁。
      const lockName = `zhs-resource-opener:${route()?.course || 'unknown'}`;
      if (navigator.locks) {
        await navigator.locks.request(lockName, { ifAvailable: true }, async lock => {
          if (!lock) throw new Error('另一个标签页正在处理这门课程，请先暂停那一页。');
          await runQueue(restored);
        });
      } else await runQueue(restored);
    } catch (error) {
      if (documentLeaving) return;
      if (runState) {
        runState.status = error.name === 'AbortError' ? 'paused' : 'error';
        try { saveRun(); } catch { /* 保留原始错误。 */ }
      }
      const message = error.name === 'AbortError' ? '已暂停；再次开始会跳过已记录的资源。' : error.message;
      ui.status.textContent = message;
      log(message);
    } finally {
      stopVideo();
      activeVideo = null;
      busy = false;
      navigating = false;
      ui.start.disabled = false;
      ui.pause.disabled = true;
      for (const el of [ui.scan, ui.reset, ui.scope, ui.seconds, ui.randomDwell, ui.onlyNew, ui.videos, ui.muted]) el.disabled = false;
      updateDwellUI();
    }
  }

  function manualStart() {
    if (busy) return;
    loadRecords();
    const saved = JSON.parse(sessionStorage.getItem(`${recordKey}:run`) || 'null');
    const settings = { scope: ui.scope.value, seconds: Number(ui.seconds.value), onlyNew: ui.onlyNew.checked,
      videos: ui.videos.checked, muted: ui.muted.checked, randomDwell: ui.randomDwell.checked };
    // 弹题或手动暂停后继续相同队列，避免从队首跳转导致当前视频重新加载。
    const sameSettings = saved?.settings && Object.keys(settings).every(k => settings[k] === saved.settings[k]);
    const samePoint = points().find(p => p.node.classList.contains('active'))?.key === saved?.queue?.[saved.index]?.key;
    if (saved?.version === 1 && ['paused', 'error'].includes(saved.status) && sameSettings && samePoint) {
      saved.status = 'running';
      start(saved);
    } else start();
  }

  function exportRecords() {
    loadRecords();
    const blob = new Blob([JSON.stringify({ version: '1.2.2', course: route().course,
      exportedAt: new Date().toISOString(), resources: Object.values(records), logs: messages,
      run: JSON.parse(sessionStorage.getItem(`${recordKey}:run`) || 'null') }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `智慧树资源访问记录-${route().course.replace(':', '-')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const host = document.createElement('div');
  host.id = PANEL_ID;
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host{position:fixed;right:18px;bottom:18px;z-index:2147483647;color:#172436;font:14px/1.55 system-ui,"Microsoft YaHei",sans-serif}
      *{box-sizing:border-box} [hidden]{display:none!important} details{width:350px;max-width:calc(100vw - 36px);border:1px solid #cfd9e6;border-radius:12px;background:#fff;box-shadow:0 8px 32px #18334f30}
      summary{padding:12px 16px;cursor:pointer;font-weight:700;background:#edf5ff;border-radius:12px} .body{padding:14px 16px;max-height:calc(100vh - 110px);overflow:auto} label{display:block;margin:8px 0}
      select,input[type=number]{font:inherit;border:1px solid #bdcbdc;border-radius:5px;padding:4px} input[type=number]{width:65px}
      button{font:inherit;border:1px solid #bdcbdc;background:#fff;border-radius:6px;padding:6px 10px;cursor:pointer} button:disabled{opacity:.45;cursor:default}
      #start{background:#2166ce;color:#fff;border-color:#2166ce} .buttons{display:flex;gap:7px;flex-wrap:wrap;margin:12px 0}
      #status{overflow-wrap:anywhere;margin:10px 0;font-weight:600} #stats,.hint{font-size:12px;color:#53657b} pre{white-space:pre-wrap;overflow-wrap:anywhere;font-family:inherit;font-size:12px;line-height:1.5;min-height:64px;max-height:140px;overflow:auto;background:#f4f7fb;padding:8px;border-radius:6px}
    </style>
    <details open><summary>学习资源逐个打开 · v1.2.2</summary><div class="body">
      <div class="hint">逐个打开资源；视频按原速播放并检查完成标记。</div>
      <label>范围 <select id="scope"><option value="all">全部知识点</option><option value="current">仅当前知识点（试跑）</option></select></label>
      <label><input id="randomDwell" type="checkbox" checked> 图文每次随机停留 1～5 秒</label>
      <label id="fixedWait" hidden>图文固定停留 <input id="seconds" type="number" min="1" max="60" value="4"> 秒</label>
      <label><input id="onlyNew" type="checkbox" checked> 跳过本标签页已访问记录</label>
      <label><input id="videos" type="checkbox" checked> 播放未完成的视频（含选学）</label>
      <label><input id="muted" type="checkbox" checked> 静音播放</label>
      <div class="buttons"><button id="scan">扫描</button><button id="start">开始 / 继续</button><button id="pause" disabled>暂停</button></div>
      <div id="status">进入任意知识点后，点击扫描或开始。</div><div id="stats"></div>
      <div class="buttons"><button id="export">导出记录</button><button id="reset">清空访问记录</button></div>
      <div class="hint">暂停快捷键：Alt + Shift + S。运行中刷新自动接续；暂停后刷新保持暂停。</div>
      <div class="hint">弹题或播放器暂停时停止；处理题目后点“开始 / 继续”。</div>
      <div class="hint">运行日志（刷新保留，也包含在导出记录中）</div>
      <pre id="log" aria-live="polite"></pre>
    </div></details>`;
  const ui = Object.fromEntries(['scope', 'seconds', 'randomDwell', 'fixedWait', 'onlyNew', 'videos', 'muted', 'scan', 'start', 'pause', 'status', 'stats', 'export', 'reset', 'log']
    .map(id => [id, root.getElementById(id)]));
  function updateDwellUI() {
    ui.fixedWait.hidden = ui.randomDwell.checked;
    ui.seconds.disabled = busy || ui.randomDwell.checked;
  }
  ui.randomDwell.addEventListener('change', updateDwellUI);
  updateDwellUI();
  const safely = fn => () => { try { fn(); } catch (error) { ui.status.textContent = error.message; log(error.message); } };
  ui.scan.addEventListener('click', safely(scan));
  ui.start.addEventListener('click', safely(manualStart));
  ui.pause.addEventListener('click', safely(pause));
  ui.export.addEventListener('click', safely(exportRecords));
  ui.reset.addEventListener('click', safely(() => {
    const current = route();
    if (!current) throw new Error('请先进入知识点页面。');
    recordKey = `zhs-resource-opener:v1:${current.course}`;
    records = {};
    runState = null;
    sessionStorage.removeItem(`${recordKey}:run`);
    saveRecords(); summary();
    log('已清空脚本访问记录，网站进度不受影响。');
  }));
  document.addEventListener('keydown', event => {
    if (event.altKey && event.shiftKey && event.code === 'KeyS') safely(pause)();
  });
  window.addEventListener('pagehide', () => {
    // pagehide 不等于用户暂停：状态已在点击前保存，旧文档不应再将其覆盖为错误。
    documentLeaving = true;
    controller?.abort();
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted) {
      documentLeaving = false;
      // 从后退缓存恢复时旧任务不再运行，不自动接续过期队列。
      ui.status.textContent = '页面从浏览器缓存恢复；请点击开始继续。';
    }
  });
  document.body.appendChild(host);
  renderLogs();
  safely(() => {
    if (!route()) return;
    loadRecords();
    summary();
    const savedRun = JSON.parse(sessionStorage.getItem(`${recordKey}:run`) || 'null');
    if (!savedRun) return;
    if (savedRun.version !== 1 || savedRun.course !== route().course || !Array.isArray(savedRun.queue) ||
        !Number.isInteger(savedRun.index) || savedRun.index < 0 || savedRun.index > savedRun.queue.length ||
        !Array.isArray(savedRun.doneResources) || !savedRun.settings) {
      throw new Error('保存的任务格式不兼容，请清空访问记录后重试。');
    }
    ui.scope.value = savedRun.settings.scope;
    ui.seconds.value = savedRun.settings.seconds;
    ui.onlyNew.checked = savedRun.settings.onlyNew;
    ui.videos.checked = savedRun.settings.videos ?? true;
    ui.muted.checked = savedRun.settings.muted ?? true;
    if (typeof savedRun.settings.randomDwell !== 'boolean') {
      savedRun.settings.randomDwell = true;
      sessionStorage.setItem(`${recordKey}:run`, JSON.stringify(savedRun));
    }
    ui.randomDwell.checked = savedRun.settings.randomDwell;
    updateDwellUI();
    if (typeof savedRun.settings.videos !== 'boolean') {
      if (savedRun.status === 'running') {
        savedRun.status = 'paused';
        sessionStorage.setItem(`${recordKey}:run`, JSON.stringify(savedRun));
      }
      ui.status.textContent = '已升级视频版。点击开始重新扫描；旧版跳过的视频会重新处理，图文记录保留。';
      log('旧版队列未自动接续，避免漏掉此前跳过的视频。请点击开始。');
      return;
    }
    if (savedRun.status === 'running' && savedRun.index < savedRun.queue.length) {
      ui.status.textContent = '检测到运行中任务，等待页面加载后自动继续……';
      start(savedRun);
    } else {
      ui.status.textContent = savedRun.status === 'complete' ? '上次访问已结束；日志和记录已恢复。' : '上次任务已暂停或停止；日志已恢复，点击开始可继续。';
    }
  })();
})();
