const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '..', 'zhihuishu-open-resources.user.js'), 'utf8');
const course = '9000000000000000001';
const ids = ['9000000000000000002', '9000000000000000003'];
const url = id => `https://ai-smart-course-student-pro.zhihuishu.com/learnPage/${course}/${id}/256522`;
const key = `zhs-resource-opener:v1:${course}:256522`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 3500) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (fn()) return; await sleep(5); }
  throw new Error('Test timed out');
}

// 最小站点模拟：使用现场观察到的 class、折叠目录、分组数量和卡片状态。
// 验证整段用户脚本通过其面板驱动 DOM，不向生产脚本添加测试后门。
function fixture(options = {}) {
  const initial = options.initialPoint || 0;
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(`<!doctype html><body>
    <div class="section-item-collapse"><div class="el-collapse">
      ${ids.map((id, i) => `<div class="el-collapse-item">
        <button class="el-collapse-item__header" aria-expanded="${i === 0}"><div class="title-text"><p>模块${i + 1}</p></div></button>
        <div class="el-collapse-item__wrap" style="display:${i === 0 ? 'block' : 'none'}">
          <div class="section-item-collapse-info ${i === 0 ? 'active' : ''}" data-point="${i}"><div class="section-item-collapse-title"><div class="title-text">知识点${i + 1}</div></div></div>
        </div></div>`).join('')}
    </div></div>
    <div id="middle-section-id"><div class="point-title-text">知识点1</div>
      <div class="preview-content"><div class="empty-previewType">请点击知识点资源学习～</div></div>
      <div class="resources-detail-card"></div><div class="el-loading-mask" style="display:none"></div>
    </div></body>`, { url: url(ids[initial]), runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const w = dom.window;
  const d = w.document;
  const calls = [];
  const mediaEvents = [];
  let latestVideo = null;
  const realTimeout = w.setTimeout.bind(w);
  w.setTimeout = (fn, ms, ...args) => realTimeout(fn, Math.max(1, ms / 100), ...args);
  w.Date.now = () => Date.now() * 100;
  w.HTMLElement.prototype.getClientRects = function () {
    for (let n = this; n && n.nodeType === 1; n = n.parentElement) {
      if (n.style.display === 'none' || n.hidden) return [];
    }
    return [{ width: 100, height: 30 }];
  };
  if (options.saved) w.sessionStorage.setItem(key, options.saved);
  for (const [k, v] of Object.entries(options.storage || {})) w.sessionStorage.setItem(k, v);
  const storage = () => Object.fromEntries(Array.from({ length: w.sessionStorage.length }, (_, i) => {
    const k = w.sessionStorage.key(i); return [k, w.sessionStorage.getItem(k)];
  }));
  let navigation = null;
  function leave(index, resource = null) {
    w.dispatchEvent(new w.PageTransitionEvent('pagehide'));
    navigation = { index, resource, storage: storage() };
  }
  virtualConsole.on('jsdomError', error => {
    if (options.captureReload && /navigation/.test(error.message)) {
      leave(current, d.querySelector('.basic-info-video-card-container.active h5')?.textContent);
    } else throw error;
  });
  let current = 0;
  const content = d.querySelector('.resources-detail-card');
  const loading = d.querySelector('.el-loading-mask');
  const data = [
    [{ title: '教材片段', type: 'book', finished: false }, { title: '共享课件.ppt', type: 'other', finished: true }, { title: '选学视频', type: 'video', optional: true }],
    [{ title: '共享课件.ppt', type: 'other', finished: true }, { title: '选学图文', type: 'other', optional: true, finished: true }],
  ];
  if (options.afterVideoDoc) data[0].push({ title: '视频后图文', type: 'other', optional: true, finished: true });
  function mountVideo(card) {
    d.querySelector('.preview-content').innerHTML = '<div class="video-player-wrapper"><video src="https://example.com/video.mp4"></video></div>';
    const video = d.querySelector('video');
    const state = { paused: true, ended: false, currentTime: 0, duration: 10, readyState: 1, error: null, questionHandled: false };
    latestVideo = { video, state };
    for (const property of ['paused', 'ended', 'currentTime', 'duration', 'readyState', 'error']) {
      Object.defineProperty(video, property, { get: () => state[property] });
    }
    let timer = null;
    const advance = () => {
      if (state.paused || options.videoMode === 'stall') return;
      state.currentTime++;
      if (options.videoMode === 'mid-pause' && state.currentTime === 3) {
        state.paused = true;
        return;
      }
      if (options.videoMode === 'question' && !state.questionHandled && state.currentTime >= 3) {
        state.paused = true;
        const question = d.createElement('div'); question.setAttribute('role', 'dialog');
        question.id = 'quiz'; question.textContent = '随堂问题，请作答'; d.body.appendChild(question);
        return;
      }
      if (state.currentTime >= state.duration) {
        state.currentTime = state.duration; state.paused = true; state.ended = true;
        if (options.videoMode === 'late-ended') {
          state.ended = false;
          realTimeout(() => { state.ended = true; video.dispatchEvent(new w.Event('ended')); }, 15);
        } else if (options.videoMode === 'reset-ended') {
          video.dispatchEvent(new w.Event('ended'));
          state.ended = false;
          state.currentTime = 0;
        } else if (options.videoMode?.startsWith('tail-pause')) {
          state.ended = false;
          state.currentTime = state.duration - 0.2;
        }
        mediaEvents.push('ended');
        if (!['no-confirm', 'tail-pause-unconfirmed'].includes(options.videoMode)) realTimeout(() => {
          card.querySelector('.finished-icon').textContent = '100%'; mediaEvents.push('site-completed');
        }, options.videoMode === 'delayed-confirm' ? 50 : 0);
      } else timer = realTimeout(advance, 10);
    };
    video.play = () => {
      mediaEvents.push('play');
      if (options.videoMode === 'blocked') return Promise.reject(new w.DOMException('Blocked', 'NotAllowedError'));
      state.paused = false;
      w.clearTimeout(timer);
      timer = realTimeout(advance, 10);
      return Promise.resolve();
    };
    video.pause = () => { state.paused = true; w.clearTimeout(timer); mediaEvents.push('pause'); };
    if (options.siteAutoplay) video.play();
    if (options.videoAlreadyFinished) {
      state.ended = true; state.currentTime = state.duration;
      card.querySelector('.finished-icon').textContent = '已完成';
    }
  }
  function mount(index) {
    current = index;
    content.replaceChildren();
    for (const optional of [false, true]) {
      const items = data[index].filter(r => !!r.optional === optional);
      const section = d.createElement('div');
      section.className = 'resources-section';
      section.innerHTML = `<div class="resources-detail-title">${optional ? '选学资源' : '必学资源'}</div><div class="tag tag-active">全部 · <span class="tag-num">${items.length + (options.countMismatch && !optional ? 1 : 0)}</span></div><div class="resources-list"></div>`;
      for (const resource of items) {
        const card = d.createElement('div');
        card.className = 'basic-info-video-card-container';
        card.innerHTML = `<div class="icon-box ${resource.type}"></div><h5 class="video-title"></h5><div class="finished-icon"></div>`;
        card.querySelector('h5').textContent = resource.title;
        if (resource.type === 'video') card.querySelector('.finished-icon').textContent = '0%';
        card.addEventListener('click', () => {
          calls.push(`${current}:${resource.title}`);
          mediaEvents.push(`click:${resource.title}`);
          if (options.hardResource) { leave(current, resource.title); return; }
          content.querySelectorAll('.active').forEach(e => e.classList.remove('active'));
          card.classList.add('active');
          d.querySelector('.preview-content').innerHTML = '<div class="empty-previewType">请点击知识点资源学习～</div>';
          if (!options.brokenPreview) realTimeout(() => {
            if (resource.type === 'video') mountVideo(card);
            else d.querySelector('.preview-content').innerHTML = '<div class="ppt-preview-box">资源正文</div>';
            if (resource.finished) card.querySelector('.finished-icon').textContent = '已完成';
          }, 8);
        });
        if (options.activeResource === resource.title) {
          card.classList.add('active');
          d.querySelector('.preview-content').innerHTML = '<div class="ppt-preview-box">资源正文</div>';
          if (resource.finished) card.querySelector('.finished-icon').textContent = '已完成';
          if (resource.type === 'video') mountVideo(card);
        }
        if (options.videoAlreadyFinished && resource.type === 'video') card.querySelector('.finished-icon').textContent = '已完成';
        section.querySelector('.resources-list').appendChild(card);
      }
      content.appendChild(section);
    }
    loading.style.display = 'none';
  }
  d.querySelectorAll('.el-collapse-item__header').forEach(header => header.addEventListener('click', () => {
    header.setAttribute('aria-expanded', 'true');
    header.nextElementSibling.style.display = 'block';
  }));
  d.querySelectorAll('[data-point]').forEach(point => point.addEventListener('click', () => {
    const i = Number(point.dataset.point);
    if (options.hardNavigate) { leave(i); return; }
    w.history.pushState({}, '', url(ids[i]));
    d.querySelectorAll('[data-point]').forEach(e => e.classList.remove('active'));
    point.classList.add('active');
    d.querySelector('.point-title-text').textContent = `知识点${i + 1}`;
    loading.style.display = 'block';
    // 切换时刻意保留旧资源，模拟异步响应。
    realTimeout(() => mount(i), 45);
  }));
  d.querySelectorAll('[data-point]').forEach(point => point.classList.toggle('active', Number(point.dataset.point) === initial));
  const initialHeader = d.querySelectorAll('.el-collapse-item__header')[initial];
  initialHeader.setAttribute('aria-expanded', 'true');
  initialHeader.nextElementSibling.style.display = 'block';
  d.querySelector('.point-title-text').textContent = `知识点${initial + 1}`;
  mount(initial);
  let randomCalls = 0;
  if (options.randomValues) w.Math.random = () => options.randomValues[randomCalls++ % options.randomValues.length];
  w.eval(source);
  const root = d.getElementById('zhs-resource-opener-v1').shadowRoot;
  const ui = id => root.getElementById(id);
  if (!options.storage?.[`${key}:run`]) ui('videos').checked = !!options.videoEnabled;
  if (!options.storage?.[`${key}:run`]) {
    ui('randomDwell').checked = !!options.randomDwell;
    ui('randomDwell').dispatchEvent(new w.Event('change'));
  }
  const records = () => JSON.parse(w.sessionStorage.getItem(key) || '{}');
  const done = () => !ui('start').disabled;
  return { dom, w, d, calls, mediaEvents, get media() { return latestVideo; }, ui, records, done, storage,
    get navigation() { return navigation; }, get randomCalls() { return randomCalls; }, close: () => dom.window.close() };
}

test('遍历折叠目录、异步资源列表、同名课件；区分网站完成并跳过视频', async () => {
  const f = fixture();
  try {
    f.ui('start').click();
    await until(f.done);
    assert.match(f.ui('status').textContent, /本轮非视频资源访问结束/);
    assert.deepEqual(f.calls, ['0:教材片段', '0:共享课件.ppt', '1:共享课件.ppt', '1:选学图文']);
    const entries = Object.values(f.records());
    assert.equal(entries.filter(r => r.status === 'visited').length, 4);
    assert.equal(entries.filter(r => r.siteFinished).length, 3);
    assert.equal(entries.filter(r => r.status === 'skipped-media').length, 1);
    assert.ok(Object.keys(f.records()).some(k => k.includes(ids[1])));
    assert.equal(f.d.querySelectorAll('.el-collapse-item__header')[1].getAttribute('aria-expanded'), 'true');
    f.ui('start').click();
    await until(f.done);
    assert.equal(f.calls.length, 4, '继续不会重复点击已访问资源');
  } finally { f.close(); }
});

test('暂停立即阻止后续点击；未完成的访问在继续时重试', async () => {
  const f = fixture();
  try {
    f.ui('scope').value = 'current';
    f.ui('seconds').value = '60';
    f.ui('start').click();
    await until(() => f.calls.length === 1);
    f.ui('pause').click();
    await until(f.done);
    await sleep(40);
    assert.equal(f.calls.length, 1);
    assert.equal(Object.keys(f.records()).length, 0);
    assert.match(f.ui('status').textContent, /已暂停/);
    f.ui('seconds').value = '2';
    f.ui('start').click();
    await until(f.done);
    assert.deepEqual(f.calls, ['0:教材片段', '0:教材片段', '0:共享课件.ppt']);
  } finally { f.close(); }
});

test('重建页面不自动开始，保留记录后可以续跑；可取消跳过以重访', async () => {
  let f = fixture();
  try {
    f.ui('scope').value = 'current';
    f.ui('start').click(); await until(f.done);
    const saved = f.w.sessionStorage.getItem(key);
    f.close(); f = fixture({ saved });
    await sleep(30);
    assert.equal(f.calls.length, 0);
    f.ui('start').click(); await until(f.done);
    assert.deepEqual(f.calls, ['1:共享课件.ppt', '1:选学图文']);
    f.ui('scope').value = 'current'; f.ui('onlyNew').checked = false;
    f.ui('start').click(); await until(f.done);
    assert.equal(f.calls.length, 4);
  } finally { f.close(); }
});

test('卡片数量不足时停止，不把不完整的列表当作本轮完成', async () => {
  const f = fixture({ countMismatch: true });
  try {
    f.ui('start').click(); await until(f.done);
    assert.match(f.ui('status').textContent, /等待超时/);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('空预览不能记录为已访问', async () => {
  const f = fixture({ brokenPreview: true });
  try {
    f.ui('start').click(); await until(f.done);
    assert.match(f.ui('status').textContent, /资源预览显示/);
    assert.equal(Object.keys(f.records()).length, 0);
    assert.equal(f.calls.length, 1);
  } finally { f.close(); }
});

test('弹窗阻止运行；手动切换知识点停止后续访问', async () => {
  const f = fixture();
  try {
    const dialog = f.d.createElement('div'); dialog.setAttribute('role', 'dialog'); f.d.body.appendChild(dialog);
    f.ui('start').click(); await until(f.done);
    assert.match(f.ui('status').textContent, /弹窗/);
    assert.equal(f.calls.length, 0);
    dialog.remove(); f.ui('seconds').value = '60'; f.ui('start').click();
    await until(() => f.calls.length === 1);
    f.w.history.pushState({}, '', url(ids[1]));
    await until(f.done);
    assert.match(f.ui('status').textContent, /手动切换知识点/);
    assert.equal(Object.keys(f.records()).length, 0);
  } finally { f.close(); }
});

test('重复加载脚本不创建第二个面板；课程 ID 隔离记录', () => {
  const f = fixture();
  try {
    f.w.eval(source);
    assert.equal(f.d.querySelectorAll('#zhs-resource-opener-v1').length, 1);
    f.w.sessionStorage.setItem('unrelated-record', 'keep');
    f.ui('reset').click();
    assert.equal(f.w.sessionStorage.getItem('unrelated-record'), 'keep');
    f.w.history.pushState({}, '', `https://ai-smart-course-student-pro.zhihuishu.com/learnPage/999/${ids[0]}/256522`);
    f.ui('scan').click();
    assert.match(f.ui('stats').textContent, /已访问 0/);
  } finally { f.close(); }
});

test('整页跳转后自动接续目标知识点，日志保留且不会跳回队首', async () => {
  let f = fixture({ hardNavigate: true });
  try {
    f.ui('seconds').value = '2';
    f.ui('onlyNew').checked = false;
    f.ui('start').click();
    await until(() => f.navigation);
    const nav = f.navigation;
    assert.equal(nav.index, 1);
    assert.deepEqual(f.calls, ['0:教材片段', '0:共享课件.ppt']);
    const task = JSON.parse(nav.storage[`${key}:run`]);
    assert.equal(task.index, 1);
    assert.equal(task.status, 'running');
    assert.equal(task.pending.kind, 'point');
    const previousLogs = JSON.parse(nav.storage[`${key}:logs`]);
    f.close();
    f = fixture({ initialPoint: nav.index, storage: nav.storage, hardNavigate: true });
    await until(f.done);
    assert.match(f.ui('status').textContent, /本轮非视频资源访问结束/);
    assert.deepEqual(f.calls, ['1:共享课件.ppt', '1:选学图文']);
    assert.equal(f.navigation, null);
    assert.equal(f.ui('seconds').value, '2');
    assert.equal(f.ui('onlyNew').checked, false);
    assert.ok(f.ui('log').textContent.includes(previousLogs[0]));
    assert.match(f.ui('log').textContent, /自动接续知识点 2\/2/);
    assert.equal(JSON.parse(f.storage()[`${key}:run`]).status, 'complete');
  } finally { f.close(); }
});

test('资源点击导致整页加载后验证选中资源，不重复点击引发刷新循环', async () => {
  let f = fixture({ hardResource: true });
  try {
    f.ui('scope').value = 'current';
    f.ui('onlyNew').checked = false;
    f.ui('start').click();
    const visitedCalls = [];
    for (let n = 0; n < 2; n++) {
      await until(() => f.navigation);
      const nav = f.navigation;
      visitedCalls.push(...f.calls);
      f.close();
      f = fixture({ initialPoint: nav.index, storage: nav.storage, activeResource: nav.resource, hardResource: true });
    }
    await until(f.done);
    assert.match(f.ui('status').textContent, /本轮非视频资源访问结束/);
    assert.deepEqual(visitedCalls, ['0:教材片段', '0:共享课件.ppt']);
    assert.equal(f.calls.length, 0);
    assert.equal(Object.values(f.records()).filter(r => r.status === 'visited').length, 2);
  } finally { f.close(); }
});

test('用户暂停后刷新仍暂停，日志和设置恢复', async () => {
  let f = fixture();
  try {
    f.ui('scope').value = 'current'; f.ui('seconds').value = '60'; f.ui('start').click();
    await until(() => f.calls.length === 1);
    f.ui('pause').click();
    assert.equal(JSON.parse(f.storage()[`${key}:run`]).status, 'paused', '暂停同步落盘');
    await until(f.done);
    const storage = f.storage(); f.close(); f = fixture({ storage });
    await sleep(60);
    assert.equal(f.calls.length, 0);
    assert.equal(f.ui('seconds').value, '60');
    assert.equal(f.ui('scope').value, 'current');
    assert.match(f.ui('log').textContent, /已暂停/);
    assert.match(f.ui('status').textContent, /暂停或停止/);
  } finally { f.close(); }
});

test('刷新落到无关知识点不自动操作，并保存停止原因', async () => {
  let f = fixture({ hardResource: true });
  try {
    f.ui('scope').value = 'current'; f.ui('start').click();
    await until(() => f.navigation);
    const storage = f.navigation.storage;
    f.close(); f = fixture({ initialPoint: 1, storage });
    await until(f.done);
    assert.equal(f.calls.length, 0);
    assert.match(f.ui('status').textContent, /不一致/);
    assert.equal(JSON.parse(f.storage()[`${key}:run`]).status, 'error');
  } finally { f.close(); }
});

test('资源刷新后不保持选中时限制重试，不无限刷新', async () => {
  let f = fixture({ hardResource: true });
  try {
    f.ui('scope').value = 'current'; f.ui('start').click();
    for (let i = 0; i < 2; i++) {
      await until(() => f.navigation);
      const storage = f.navigation.storage;
      f.close(); f = fixture({ storage, hardResource: true });
    }
    await until(f.done);
    assert.equal(f.calls.length, 0);
    assert.match(f.ui('status').textContent, /停止重复刷新/);
    assert.equal(Object.keys(f.records()).length, 0);
  } finally { f.close(); }
});

test('视频自然播完且网站确认后才打开下一资源', async () => {
  const f = fixture({ videoEnabled: true, afterVideoDoc: true, videoMode: 'delayed-confirm' });
  try {
    f.ui('scope').value = 'current'; f.ui('seconds').value = '2'; f.ui('start').click();
    await until(f.done);
    assert.match(f.ui('status').textContent, /本轮资源处理结束/);
    const sequence = f.mediaEvents;
    assert.ok(sequence.indexOf('ended') < sequence.indexOf('site-completed'));
    assert.ok(sequence.indexOf('site-completed') < sequence.indexOf('click:视频后图文'));
    const result = Object.values(f.records()).find(r => r.title === '选学视频');
    assert.equal(result.status, 'video-complete');
    assert.equal(result.siteFinished, true);
    assert.equal(result.completion, 'ended-and-site-confirmed');
    assert.equal(f.media.video.muted, true);
    assert.equal(f.media.video.playbackRate, 1);
  } finally { f.close(); }
});

for (const mode of ['late-ended', 'reset-ended', 'tail-pause']) {
  test(`正常结束后的暂停不误报，网站确认后继续：${mode}`, async () => {
    const f = fixture({ videoEnabled: true, afterVideoDoc: true, videoMode: mode });
    try {
      f.ui('scope').value = 'current'; f.ui('seconds').value = '2'; f.ui('start').click();
      await until(f.done);
      assert.match(f.ui('status').textContent, /本轮资源处理结束/);
      const result = Object.values(f.records()).find(r => r.title === '选学视频');
      assert.equal(result.status, 'video-complete');
      assert.equal(result.completion, mode === 'tail-pause' ? 'near-end-pause-and-site-confirmed' : 'ended-and-site-confirmed');
      assert.ok(f.mediaEvents.indexOf('site-completed') < f.mediaEvents.indexOf('click:视频后图文'));
      assert.equal(f.mediaEvents.filter(e => e === 'play').length, 1);
    } finally { f.close(); }
  });
}

test('无弹窗的中途持续暂停仍停止，不跳过视频', async () => {
  const f = fixture({ videoEnabled: true, afterVideoDoc: true, videoMode: 'mid-pause' });
  try {
    f.ui('scope').value = 'current'; f.ui('start').click(); await until(f.done);
    assert.match(f.ui('status').textContent, /播放器中途暂停/);
    assert.equal(f.calls.includes('0:视频后图文'), false);
    assert.equal(Object.values(f.records()).some(r => r.status === 'video-complete'), false);
  } finally { f.close(); }
});

test('末尾暂停没有完成证据时只刷新核对一次，仍未完成则停止', async () => {
  let f = fixture({ videoEnabled: true, videoMode: 'tail-pause-unconfirmed', captureReload: true });
  try {
    f.ui('scope').value = 'current'; f.ui('start').click();
    await until(() => f.navigation);
    const storage = f.navigation.storage;
    const pending = JSON.parse(storage[`${key}:run`]).pending;
    assert.equal(pending.videoProgress.ended, false);
    assert.equal(pending.completionRefresh, true);
    assert.equal(Object.values(f.records()).some(r => r.status === 'video-complete'), false);
    f.close(); f = fixture({ storage, captureReload: true });
    await until(f.done);
    assert.match(f.ui('status').textContent, /刷新核对，但网站仍未显示完成/);
    assert.equal(f.navigation, null);
    assert.equal(f.mediaEvents.includes('play'), false);
  } finally { f.close(); }
});

test('视频弹题时停止，不标完成；答题后继续不重新点击视频卡片', async () => {
  const f = fixture({ videoEnabled: true, afterVideoDoc: true, videoMode: 'question' });
  try {
    f.ui('scope').value = 'current'; f.ui('seconds').value = '2'; f.ui('start').click();
    await until(f.done);
    assert.match(f.ui('status').textContent, /弹题或网站弹窗/);
    assert.equal(f.calls.includes('0:视频后图文'), false);
    assert.equal(Object.values(f.records()).some(r => r.status === 'video-complete'), false);
    const stoppedAt = f.media.state.currentTime;
    f.media.state.questionHandled = true; f.d.getElementById('quiz').remove();
    f.ui('start').click(); await until(f.done);
    assert.match(f.ui('status').textContent, /本轮资源处理结束/);
    assert.equal(f.calls.filter(c => c === '0:选学视频').length, 1);
    assert.equal(f.mediaEvents.filter(e => e === 'play').length, 2);
    assert.ok(f.media.state.currentTime > stoppedAt);
  } finally { f.close(); }
});

test('脚本暂停也暂停视频，保留未完成状态', async () => {
  const f = fixture({ videoEnabled: true });
  try {
    f.ui('scope').value = 'current'; f.ui('seconds').value = '2'; f.ui('start').click();
    await until(() => f.mediaEvents.includes('play'));
    f.ui('pause').click();
    assert.equal(f.media.state.paused, true);
    await until(f.done);
    assert.equal(f.media.state.ended, false);
    assert.equal(Object.values(f.records()).some(r => r.status === 'video-complete'), false);
    assert.equal(JSON.parse(f.storage()[`${key}:run`]).status, 'paused');
  } finally { f.close(); }
});

test('自动播放被拒绝时提示手动播放，不跳过视频', async () => {
  const f = fixture({ videoEnabled: true, videoMode: 'blocked', afterVideoDoc: true });
  try {
    f.ui('scope').value = 'current'; f.ui('seconds').value = '2'; f.ui('start').click(); await until(f.done);
    assert.match(f.ui('status').textContent, /NotAllowedError/);
    assert.equal(f.calls.includes('0:视频后图文'), false);
    assert.equal(Object.values(f.records()).some(r => r.status === 'video-complete'), false);
  } finally { f.close(); }
});

test('视频长时间无进展时停止，不误判为播完', async () => {
  const f = fixture({ videoEnabled: true, videoMode: 'stall', afterVideoDoc: true });
  try {
    f.ui('scope').value = 'current'; f.ui('seconds').value = '2'; f.ui('start').click(); await until(f.done);
    assert.match(f.ui('status').textContent, /连续 60 秒/);
    assert.equal(f.media.state.paused, true);
    assert.equal(f.calls.includes('0:视频后图文'), false);
  } finally { f.close(); }
});

test('视频已结束但卡片未更新时刷新一次，完成状态刷新后确认', async () => {
  let f = fixture({ videoEnabled: true, videoMode: 'no-confirm', captureReload: true });
  try {
    f.ui('scope').value = 'current'; f.ui('seconds').value = '2'; f.ui('start').click();
    await until(() => f.navigation);
    const nav = f.navigation;
    const run = JSON.parse(nav.storage[`${key}:run`]);
    assert.equal(run.pending.completionRefresh, true);
    assert.equal(run.pending.videoProgress.ended, true);
    assert.equal(Object.values(f.records()).some(r => r.status === 'video-complete'), false);
    f.close(); f = fixture({ storage: nav.storage, videoAlreadyFinished: true });
    await until(f.done);
    assert.match(f.ui('status').textContent, /本轮资源处理结束/);
    assert.equal(f.mediaEvents.includes('play'), false);
    assert.equal(Object.values(f.records()).find(r => r.title === '选学视频').status, 'video-complete');
  } finally { f.close(); }
});

test('刷新后视频仍未完成则停止，不再次刷新或重新播放', async () => {
  let f = fixture({ videoEnabled: true, videoMode: 'no-confirm', captureReload: true });
  try {
    f.ui('scope').value = 'current'; f.ui('seconds').value = '2'; f.ui('start').click();
    await until(() => f.navigation);
    const storage = f.navigation.storage;
    f.close(); f = fixture({ storage, captureReload: true });
    await until(f.done);
    assert.match(f.ui('status').textContent, /刷新核对，但网站仍未显示完成/);
    assert.equal(f.mediaEvents.includes('play'), false);
    assert.equal(f.navigation, null);
  } finally { f.close(); }
});

test('旧版跳过的视频升级后会处理；旧版运行队列不自动越过前面的遗漏视频', async () => {
  let f = fixture();
  try {
    f.ui('scope').value = 'current'; f.ui('start').click(); await until(f.done);
    const storage = f.storage();
    const task = JSON.parse(storage[`${key}:run`]);
    delete task.settings.videos; delete task.settings.muted; task.status = 'running'; task.index = 0;
    storage[`${key}:run`] = JSON.stringify(task);
    f.close(); f = fixture({ storage });
    await sleep(30);
    assert.equal(f.calls.length, 0);
    assert.equal(f.ui('videos').checked, true);
    assert.match(f.ui('status').textContent, /已升级视频版/);
    f.ui('start').click(); await until(f.done);
    assert.deepEqual(f.calls, ['0:选学视频']);
    assert.equal(Object.values(f.records()).find(r => r.title === '选学视频').status, 'video-complete');
  } finally { f.close(); }
});

test('网站在监控启动前自动播放时，点击暂停也立即暂停该视频', async () => {
  const f = fixture({ videoEnabled: true, siteAutoplay: true });
  try {
    f.ui('scope').value = 'current'; f.ui('seconds').value = '60'; f.ui('start').click();
    await until(() => f.mediaEvents.includes('play'));
    f.ui('pause').click();
    assert.equal(f.media.state.paused, true);
    await until(f.done);
    assert.equal(f.media.state.ended, false);
    assert.equal(Object.values(f.records()).some(r => r.status === 'video-complete'), false);
  } finally { f.close(); }
});

test('各图文资源独立随机等待，包含 1 秒和 5 秒边界并记录实际选取时长', async () => {
  const f = fixture({ randomDwell: true, randomValues: [0, 0.999999, 0.4, 0.6] });
  try {
    f.ui('start').click(); await until(f.done);
    assert.match(f.ui('status').textContent, /本轮非视频资源访问结束/);
    assert.deepEqual(Object.values(f.records()).filter(r => r.status === 'visited').map(r => r.dwellSeconds), [1, 5, 3, 4]);
    assert.equal(f.randomCalls, 4);
    assert.match(f.ui('log').textContent, /图文停留 1 秒（随机）/);
    assert.match(f.ui('log').textContent, /图文停留 5 秒（随机）/);
    assert.equal(f.ui('fixedWait').hidden, true);
  } finally { f.close(); }
});

test('随机时长在资源整页跳转后保持，不重新抽取', async () => {
  let f = fixture({ randomDwell: true, randomValues: [0.999999], hardResource: true });
  try {
    f.ui('scope').value = 'current'; f.ui('start').click(); await until(() => f.navigation);
    const nav = f.navigation;
    assert.equal(JSON.parse(nav.storage[`${key}:run`]).pending.dwellSeconds, 5);
    f.close(); f = fixture({ storage: nav.storage, activeResource: nav.resource, randomValues: [0] });
    await until(f.done);
    assert.deepEqual(Object.values(f.records()).filter(r => r.status === 'visited').map(r => r.dwellSeconds), [5, 1]);
    assert.equal(f.randomCalls, 1);
    assert.equal(f.ui('randomDwell').checked, true);
  } finally { f.close(); }
});

test('随机图文设置不对视频抽取时长，仍等待视频和网站确认完成', async () => {
  const f = fixture({ randomDwell: true, randomValues: [0], videoEnabled: true, videoMode: 'delayed-confirm' });
  try {
    f.ui('scope').value = 'current'; f.ui('start').click(); await until(f.done);
    assert.equal(f.randomCalls, 2);
    const video = Object.values(f.records()).find(r => r.status === 'video-complete');
    assert.ok(video);
    assert.equal(video.dwellSeconds, undefined);
    assert.equal(video.completion, 'ended-and-site-confirmed');
  } finally { f.close(); }
});
