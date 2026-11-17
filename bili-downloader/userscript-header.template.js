
// ==UserScript==
// @name         B站分P智能下载管理器 V5.0
// @namespace    https://www.bilibili.com/
// @version      5.0.0
// @description  悬浮图标、折叠面板、单文件下载、智能扫描、全集下载
// @match        https://www.bilibili.com/video/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
    'use strict';

    // =====================================================
    // 1. 配置
    // =====================================================

    const CONFIG = {
        maxRetries: 3,
        quality: 127,
        preferredCodec: 7,
        interval: 5000
    };

    const API = {
        view: 'https://api.bilibili.com/x/web-interface/view',
        play: 'https://api.bilibili.com/x/player/playurl'
    };

    // =====================================================
    // 2. 全局状态
    // =====================================================

    let videoInfo = null;
    let pages = [];
    let videoTitle = '';

    let rootHandle = null;
    let folderHandle = null;

    let running = false;
    let scanning = false;
    let cancelled = false;
    let activeController = null;

    let fileStatus = new Map();

    let totalFiles = 0;
    let currentFile = '';

    let currentPercent = 0;

    // =====================================================
    // 3. 基础工具
    // =====================================================

    const $ = id =>
        document.getElementById('bvp5-' + id);

    const sleep = ms =>
        new Promise(resolve => setTimeout(resolve, ms));

    function safeName(name) {

        let result = String(name || '未命名')
            .normalize('NFC')
            .replace(/[\\/:*?"<>|\x00-\x1F]/g, '_')
            .trim()
            .replace(/[. ]+$/g, '')
            .slice(0, 150);

        if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(result)) {
            result = '_' + result;
        }

        return result || '未命名';
    }

    function getBvid() {

        const match = location.pathname.match(
            /\/video\/(BV[a-zA-Z0-9]+)/
        );

        return match ? match[1] : null;
    }

    function formatSize(bytes) {

        if (!bytes) return '0 MB';

        if (bytes < 1024 * 1024) {
            return (bytes / 1024).toFixed(1) + ' KB';
        }

        return (bytes / 1024 / 1024).toFixed(2) + ' MB';
    }

    function log(message) {

        console.log('[B站V5下载器]', message);

        const box = $('logs');

        if (!box) return;

        const item = document.createElement('div');

        item.className = 'bvp5-log-item';

        item.textContent =
            new Date().toLocaleTimeString() +
            '  ' + message;

        box.prepend(item);

        while (box.children.length > 40) {
            box.lastChild.remove();
        }
    }

    function status(message) {
        $('status').textContent = message;
    }

    function showError(message) {
        status('⚠️ ' + message);
        log('错误：' + message);
    }

    // =====================================================
    // 4. 展开与折叠管理器
    // =====================================================

    // 4. 展开与折叠管理器

    function openPanel() {
        $('panel').style.display = 'flex';
        $('launcher').style.display = 'none';
    }

    function collapsePanel() {
        $('panel').style.display = 'none';
        $('launcher').style.display = 'flex';
    }

    // =====================================================
    // 5. 网络请求
    // =====================================================

    async function getJson(url) {

        const response = await fetch(url, {
            credentials: 'include',
            headers: {
                Accept: 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error('HTTP ' + response.status);
        }

        return await response.json();
    }

    // =====================================================
    // 6. 识别全部分P
    // =====================================================

    async function identifyPages() {

        const bvid = getBvid();

        if (!bvid) {
            throw new Error('无法识别当前视频 BV 号');
        }

        status('正在识别视频信息...');

        const json = await getJson(
            API.view + '?bvid=' + encodeURIComponent(bvid)
        );

        if (json.code !== 0) {
            throw new Error(
                '视频信息获取失败：' + json.message
            );
        }

        const data = json.data;

        if (!data || !Array.isArray(data.pages)) {
            throw new Error('没有获取到分P列表');
        }

        videoTitle = safeName(data.title);

        pages = data.pages
            .slice()
            .sort((a, b) => a.page - b.page)
            .map((p, index) => ({
                index: index + 1,
                page: Number(p.page || index + 1),
                aid: String(data.aid),
                cid: String(p.cid),
                bvid,
                originalTitle: String(
                    p.part || ('P' + (index + 1))
                )
            }))
            .filter(p => p.cid);

        if (!pages.length) {
            throw new Error('没有有效的分P');
        }

        videoInfo = {
            bvid,
            aid: String(data.aid),
            title: videoTitle,
            owner: data.owner?.name || '未知UP主',
            total: pages.length
        };

        fileStatus.clear();

        for (const page of pages) {

            const names = getNames(page);

            fileStatus.set(names.video, 'missing');
            fileStatus.set(names.audio, 'missing');
        }

        totalFiles = pages.length * 2;

        renderVideoInfo();
        renderList();
        updateStats();

        $('scan').disabled = false;
        $('start').disabled = true;

        status(
            '识别成功，共 ' + pages.length + ' 个分P'
        );

        log(
            '识别成功：' +
            videoTitle +
            '，共 ' + pages.length + ' P'
        );

        return videoInfo;
    }

    // =====================================================
    // 7. 文件命名
    // =====================================================

    function getNames(page) {

        const prefix = String(page.index)
            .padStart(3, '0');

        const base =
            prefix + '_' + safeName(page.originalTitle);

        return {
            video: base + '.mp4',
            audio: base + '.m4a'
        };
    }

    // =====================================================
    // 8. 文件夹权限
    // =====================================================

    async function ensureFolder() {

        if (!window.showDirectoryPicker) {
            throw new Error(
                '请使用最新版 Edge 或 Chrome'
            );
        }

        if (!rootHandle) {

            rootHandle =
                await window.showDirectoryPicker({
                    mode: 'readwrite'
                });
        }

        let permission =
            await rootHandle.queryPermission({
                mode: 'readwrite'
            });

        if (permission !== 'granted') {

            permission =
                await rootHandle.requestPermission({
                    mode: 'readwrite'
                });
        }

        if (permission !== 'granted') {
            throw new Error('没有获得文件夹读写权限');
        }

        folderHandle =
            await rootHandle.getDirectoryHandle(
                videoTitle,
                { create: true }
            );

        $('folder-name').textContent =
            rootHandle.name + ' / ' + videoTitle;
    }

    // =====================================================
    // 9. 检查文件是否存在
    // =====================================================

    async function checkFile(filename) {

        try {

            const handle =
                await folderHandle.getFileHandle(filename);

            const file = await handle.getFile();

            return file.size > 0;

        } catch (error) {

            return false;
        }
    }

    // =====================================================
    // 10. 扫描全部文件
    // =====================================================

    async function scanFiles() {

        if (!pages.length) {
            throw new Error('请先识别视频');
        }

        await ensureFolder();

        status('正在扫描本地文件...');

        let existing = 0;
        let missing = 0;

        const tasks = [];

        for (const page of pages) {

            const names = getNames(page);

            tasks.push(names.video);
            tasks.push(names.audio);
        }

        totalFiles = tasks.length;

        for (let i = 0; i < tasks.length; i++) {

            const filename = tasks[i];

            const exists = await checkFile(filename);

            fileStatus.set(
                filename,
                exists ? 'exists' : 'missing'
            );

            if (exists) existing++;
            else missing++;

            if (i % 5 === 0 || i === tasks.length - 1) {

                status(
                    '正在扫描文件 ' +
                    (i + 1) + '/' + tasks.length
                );
            }
        }

        renderList();
        updateStats();

        $('start').disabled = missing === 0;

        status(
            '扫描完成：已存在 ' +
            existing + ' 个，缺失 ' +
            missing + ' 个'
        );

        log(
            '扫描完成：存在 ' +
            existing + '，缺失 ' + missing
        );

        return { existing, missing };
    }

    // =====================================================
    // 11. 获取 DASH 音视频地址
    // =====================================================

    async function getDash(page) {

        const params = new URLSearchParams({
            avid: page.aid,
            cid: page.cid,
            qn: String(CONFIG.quality),
            otype: 'json',
            fourk: '1',
            fnver: '0',
            fnval: '4048'
        });

        const json = await getJson(
            API.play + '?' + params.toString()
        );

        if (json.code !== 0) {
            throw new Error(
                '播放地址获取失败：' + json.message
            );
        }

        const dash = json.data?.dash;

        if (!dash) {
            throw new Error('没有可用 DASH 数据');
        }

        const videos = dash.video || [];
        const audios = dash.audio || [];

        if (!videos.length || !audios.length) {
            throw new Error('音视频轨道不完整');
        }

        let videoCandidates = videos.filter(
            item =>
                Number(item.codecid) === CONFIG.preferredCodec
        );

        if (!videoCandidates.length) {
            videoCandidates = videos;
        }

        const video = [...videoCandidates].sort(
            (a, b) =>
                Number(b.bandwidth || 0) -
                Number(a.bandwidth || 0)
        )[0];

        // 优先 AAC 音轨
        const aac = audios.filter(item =>
            /mp4a/i.test(
                String(item.codecs || '') +
                ' ' + String(item.mimeType || '')
            )
        );

        const audioCandidates = aac.length ? aac : audios;

        const audio = [...audioCandidates].sort(
            (a, b) =>
                Number(b.bandwidth || 0) -
                Number(a.bandwidth || 0)
        )[0];

        function parse(item) {
            return {
                url: item.baseUrl || item.base_url,
                backups:
                    item.backupUrl ||
                    item.backup_url ||
                    []
            };
        }

        return {
            video: parse(video),
            audio: parse(audio)
        };
    }

    // =====================================================
    // 12. 文件统计
    // =====================================================

    function getCounts() {

        let exists = 0;
        let missing = 0;
        let downloading = 0;
        let downloaded = 0;
        let failed = 0;

        for (const value of fileStatus.values()) {

            if (value === 'exists') exists++;
            if (value === 'missing') missing++;
            if (value === 'downloading') downloading++;
            if (value === 'downloaded') downloaded++;
            if (value === 'failed') failed++;
        }

        return {
            exists,
            missing,
            downloading,
            downloaded,
            failed,
            complete: exists + downloaded
        };
    }

    function updateStats() {

        const c = getCounts();

        $('stat-total').textContent = totalFiles;
        $('stat-exists').textContent = c.exists;
        $('stat-missing').textContent = c.missing;
        $('stat-downloaded').textContent = c.downloaded;
        $('stat-failed').textContent = c.failed;

        const percent = totalFiles
            ? c.complete / totalFiles * 100
            : 0;

        $('bar').style.width = percent + '%';

        $('percent').textContent =
            percent.toFixed(1) + '%';

        $('progress-label').textContent =
            c.complete + ' / ' +
            totalFiles + ' 个文件已完成';
    }

    // =====================================================
    // 13. 状态标签
    // =====================================================

    function getStatusLabel(value) {

        const labels = {
            exists: ['已存在', 'green'],
            missing: ['待下载', 'orange'],
            downloading: ['下载中', 'blue'],
            downloaded: ['已下载', 'green'],
            failed: ['下载失败', 'red']
        };

        return labels[value] || ['未知', 'gray'];
    }

    // =====================================================
    // 14. 渲染分P列表
    // =====================================================

    function renderList() {

        const box = $('list');

        box.replaceChildren();

        if (!pages.length) {

            const empty = document.createElement('div');

            empty.className = 'bvp5-empty';
            empty.textContent = '请先识别分P';

            box.appendChild(empty);

            return;
        }

        for (const page of pages) {

            const names = getNames(page);

            const card = document.createElement('div');

            card.className = 'bvp5-page-card';

            const title = document.createElement('div');

            title.className = 'bvp5-page-title';

            title.textContent =
                String(page.index).padStart(3, '0') +
                '_' + page.originalTitle;

            const files = document.createElement('div');

            files.className = 'bvp5-file-row';

            // MP4 单文件下载按钮
            const video = createFileButton(
                names.video,
                'MP4 视频',
                'video'
            );

            // M4A 单文件下载按钮
            const audio = createFileButton(
                names.audio,
                'M4A 音频',
                'audio'
            );

            files.append(video, audio);

            card.append(title, files);

            box.appendChild(card);
        }
    }

    function createFileButton(filename, label, type) {

        const value =
            fileStatus.get(filename) || 'missing';

        const [stateText, color] =
            getStatusLabel(value);

        const button = document.createElement('button');

        button.className =
            'bvp5-file-button ' + color;

        button.dataset.file = filename;
        button.dataset.type = type;

        const left = document.createElement('span');
        left.textContent = label;

        const right = document.createElement('span');

        right.className = 'bvp5-file-state';
        right.textContent =
            stateText +
            (
                value === 'exists' ||
                value === 'downloaded'
                    ? ''
                    : ' · 点击下载'
            );

        button.append(left, right);

        button.disabled =
            running ||
            value === 'exists' ||
            value === 'downloaded' ||
            value === 'downloading';

        return button;
    }

    // =====================================================
    // 15. 单个文件下载
    // =====================================================

    async function downloadSingleFile(filename, type) {

        if (running) return;

        const page = pages.find(p => {
            const names = getNames(p);

            return names.video === filename ||
                   names.audio === filename;
        });

        if (!page) {
            showError('无法找到对应分P');
            return;
        }

        running = true;
        cancelled = false;

        $('identify').disabled = true;
        $('scan').disabled = true;
        $('start').disabled = true;
        $('stop').disabled = false;

        try {

            // 第一次点击单文件时，自动选择目录
            await ensureFolder();

            // 下载前重新检查
            if (await checkFile(filename)) {

                fileStatus.set(filename, 'exists');

                log('文件已存在，跳过：' + filename);

                status('文件已经存在，无需重复下载');

                return;
            }

            fileStatus.set(filename, 'downloading');

            renderList();
            updateStats();

            status(
                '正在获取 P' + page.page +
                ' 的下载地址...'
            );

            const dash = await getDash(page);

            const stream =
                type === 'video'
                    ? dash.video
                    : dash.audio;

            currentFile = filename;

            fileStatus.set(filename, 'downloading');

            renderList();

            await downloadFile(stream, filename);

            status('单个文件下载完成：' + filename);

            log('单文件任务完成：' + filename);

        } catch (error) {

            if (!cancelled) {

                fileStatus.set(filename, 'failed');

                showError(error.message);
            }

        } finally {

            running = false;
            activeController = null;
            currentPercent = 0;

            $('identify').disabled = false;
            $('scan').disabled = false;
            $('start').disabled = false;
            $('stop').disabled = true;

            renderList();
            updateStats();
        }
    }

    // =====================================================
    // 16. 流式下载到磁盘
    // =====================================================

    async function downloadFile(streamInfo, filename) {

        const urls = [
            streamInfo.url,
            ...(streamInfo.backups || [])
        ].filter(Boolean);

        if (!urls.length) {
            throw new Error('没有可用下载地址');
        }

        let lastError = null;

        for (
            let attempt = 0;
            attempt < CONFIG.maxRetries;
            attempt++
        ) {

            if (cancelled) {
                throw new Error('下载已停止');
            }

            let reader = null;
            let writable = null;

            try {

                activeController = new AbortController();

                const url = urls[attempt % urls.length];

                log(
                    '开始下载：' + filename +
                    '，尝试 ' + (attempt + 1)
                );

                const response = await fetch(url, {
                    method: 'GET',
                    mode: 'cors',
                    credentials: 'omit',
                    referrer: location.href,
                    referrerPolicy: 'strict-origin-when-cross-origin',
                    signal: activeController.signal
                });

                if (!response.ok) {
                    throw new Error(
                        'CDN HTTP ' + response.status
                    );
                }

                if (!response.body) {
                    throw new Error('无法读取响应数据流');
                }

                const contentLength = Number(
                    response.headers.get('content-length') || 0
                );

                const handle =
                    await folderHandle.getFileHandle(
                        filename,
                        { create: true }
                    );

                writable = await handle.createWritable();

                reader = response.body.getReader();

                let downloaded = 0;

                const startTime = Date.now();

                while (true) {

                    if (cancelled) {
                        throw new Error('下载已停止');
                    }

                    const { done, value } =
                        await reader.read();

                    if (done) break;

                    await writable.write(value);

                    downloaded += value.byteLength;

                    const elapsed = Math.max(
                        0.1,
                        (Date.now() - startTime) / 1000
                    );

                    const speed =
                        downloaded / elapsed / 1024 / 1024;

                    $('speed').textContent =
                        speed.toFixed(2) + ' MB/s';

                    currentPercent = contentLength
                        ? Math.min(0.99, downloaded / contentLength)
                        : 0;

                    $('current-file').textContent =
                        filename + ' · ' +
                        formatSize(downloaded);

                    const counts = getCounts();

                    const percent = totalFiles
                        ? (
                            (counts.complete + currentPercent) /
                            totalFiles
                        ) * 100
                        : 0;

                    $('bar').style.width =
                        percent + '%';

                    $('percent').textContent =
                        percent.toFixed(1) + '%';
                }

                await writable.close();

                writable = null;
                activeController = null;

                fileStatus.set(filename, 'downloaded');

                currentPercent = 0;

                updateStats();
                renderList();

                log(
                    '下载完成：' +
                    filename +
                    '，大小：' +
                    formatSize(downloaded)
                );

                return true;

            } catch (error) {

                lastError = error;

                if (reader) {
                    await reader.cancel().catch(() => {});
                }

                if (writable) {
                    await writable.abort().catch(() => {});
                }

                activeController = null;

                if (cancelled) {
                    throw new Error('下载已停止');
                }

                log(
                    filename +
                    ' 下载失败：' +
                    error.message
                );

                if (attempt + 1 < CONFIG.maxRetries) {
                    await sleep(1500);
                }
            }
        }

        throw lastError || new Error('下载失败');
    }

    // =====================================================
    // 17. 批量下载所有缺失文件
    // =====================================================

    async function downloadMissing() {

        if (running) return;

        if (!pages.length) {
            showError('请先识别分P');
            return;
        }

        try {

            // 下载前重新扫描
            await scanFiles();

        } catch (error) {

            showError(error.message);
            return;
        }

        if (getCounts().missing === 0) {

            status('所有文件已经存在，无需下载');

            return;
        }

        running = true;
        cancelled = false;

        $('identify').disabled = true;
        $('scan').disabled = true;
        $('start').disabled = true;
        $('stop').disabled = false;

        log('开始批量下载缺失文件');

        for (const page of pages) {

            if (cancelled) break;

            const names = getNames(page);

            const needVideo =
                fileStatus.get(names.video) === 'missing' ||
                fileStatus.get(names.video) === 'failed';

            const needAudio =
                fileStatus.get(names.audio) === 'missing' ||
                fileStatus.get(names.audio) === 'failed';

            if (!needVideo && !needAudio) {
                continue;
            }

            try {

                status('正在解析 P' + page.page);

                const dash = await getDash(page);

                const tasks = [];

                if (needVideo) {
                    tasks.push({
                        name: names.video,
                        stream: dash.video
                    });
                }

                if (needAudio) {
                    tasks.push({
                        name: names.audio,
                        stream: dash.audio
                    });
                }

                for (const task of tasks) {

                    if (cancelled) break;

                    if (await checkFile(task.name)) {

                        fileStatus.set(task.name, 'exists');

                        updateStats();
                        renderList();

                        continue;
                    }

                    currentFile = task.name;

                    fileStatus.set(
                        task.name,
                        'downloading'
                    );

                    renderList();
                    updateStats();

                    status('正在下载：' + task.name);

                    try {

                        await downloadFile(
                            task.stream,
                            task.name
                        );

                    } catch (error) {

                        if (cancelled) break;

                        fileStatus.set(
                            task.name,
                            'failed'
                        );

                        log(
                            '文件下载失败：' +
                            task.name + ' / ' +
                            error.message
                        );

                        renderList();
                        updateStats();
                    }
                }

            } catch (error) {

                if (cancelled) break;

                if (needVideo) {
                    fileStatus.set(names.video, 'failed');
                }

                if (needAudio) {
                    fileStatus.set(names.audio, 'failed');
                }

                log(
                    'P' + page.page +
                    ' 获取地址失败：' + error.message
                );

                renderList();
                updateStats();
            }

            if (!cancelled) {
                await sleep(CONFIG.interval);
            }
        }

        running = false;
        activeController = null;
        currentPercent = 0;

        $('identify').disabled = false;
        $('scan').disabled = false;
        $('start').disabled = false;
        $('stop').disabled = true;

        $('speed').textContent = '';

        renderList();
        updateStats();

        const c = getCounts();

        status(
            cancelled
                ? '下载已停止'
                : '批量下载任务结束'
        );

        log(
            '任务结束：已存在 ' +
            c.exists +
            '，新下载 ' +
            c.downloaded +
            '，失败 ' +
            c.failed +
            '，待下载 ' +
            c.missing
        );
    }

    // =====================================================
    // 18. 停止下载
    // =====================================================

    function stopDownload() {

        if (!running) return;

        cancelled = true;

        status('正在停止下载...');

        $('stop').disabled = true;

        if (activeController) {
            activeController.abort();
        }

        log('用户请求停止下载');
    }

    // =====================================================
    // 19. 渲染视频信息
    // =====================================================

    function renderVideoInfo() {

        $('title').textContent = videoInfo.title;

        $('owner').textContent =
            'UP主：' + videoInfo.owner;

        $('total-pages').textContent =
            '分P：' + videoInfo.total;
    }

    // =====================================================
    // 20. 创建悬浮图标
    // =====================================================

    const launcher = document.createElement('button');

    launcher.id = 'bvp5-launcher';

    launcher.innerHTML = `
        <span class="bvp5-launcher-icon">↓</span>
        <span class="bvp5-launcher-dot"></span>
    `;

    // =====================================================
    // 21. 创建管理器界面
    // =====================================================

    const panel = document.createElement('div');

    panel.id = 'bvp5-panel';

    panel.innerHTML = `
        <div class="bvp5-header">
            <div class="bvp5-brand">
                <div class="bvp5-logo">B</div>
                <div>
                    <div class="bvp5-heading">Bili Downloader</div>
                    <div class="bvp5-subheading">分P智能下载管理器 V5.0</div>
                </div>
            </div>

            <div class="bvp5-header-actions">
                <button id="bvp5-collapse" title="折叠管理器">−</button>
            </div>
        </div>

        <div class="bvp5-content">

            <div class="bvp5-info-card">
                <div class="bvp5-label">当前视频</div>

                <div id="bvp5-title" class="bvp5-video-title">
                    等待识别
                </div>

                <div class="bvp5-meta">
                    <span id="bvp5-owner">UP主：--</span>
                    <span id="bvp5-total-pages">分P：--</span>
                </div>

                <div class="bvp5-folder">
                    📁 <span id="bvp5-folder-name">尚未选择目录</span>
                </div>
            </div>

            <div class="bvp5-actions">
                <button id="bvp5-identify" class="bvp5-btn secondary">
                    🔍 识别分P
                </button>

                <button id="bvp5-scan" class="bvp5-btn secondary" disabled>
                    📂 扫描文件
                </button>

                <button id="bvp5-start" class="bvp5-btn primary" disabled>
                    ⬇ 下载全部缺失
                </button>

                <button id="bvp5-stop" class="bvp5-btn danger" disabled>
                    ■ 停止
                </button>
            </div>

            <div id="bvp5-status" class="bvp5-status">
                请先识别视频
            </div>

            <div class="bvp5-stats">
                <div class="bvp5-stat">
                    <strong id="bvp5-stat-total">0</strong>
                    <span>总文件</span>
                </div>

                <div class="bvp5-stat">
                    <strong id="bvp5-stat-exists" class="green">0</strong>
                    <span>已存在</span>
                </div>

                <div class="bvp5-stat">
                    <strong id="bvp5-stat-missing" class="orange">0</strong>
                    <span>待下载</span>
                </div>

                <div class="bvp5-stat">
                    <strong id="bvp5-stat-downloaded" class="blue">0</strong>
                    <span>新下载</span>
                </div>

                <div class="bvp5-stat">
                    <strong id="bvp5-stat-failed" class="red">0</strong>
                    <span>失败</span>
                </div>
            </div>

            <div class="bvp5-section">
                <div class="bvp5-section-heading">
                    <span>下载进度</span>
                    <strong id="bvp5-percent">0%</strong>
                </div>

                <div class="bvp5-progress-track">
                    <div id="bvp5-bar" class="bvp5-progress-bar"></div>
                </div>

                <div id="bvp5-progress-label" class="bvp5-muted">
                    0 / 0 个文件已完成
                </div>

                <div class="bvp5-current">
                    <span id="bvp5-current-file">等待下载</span>
                    <strong id="bvp5-speed">0 MB/s</strong>
                </div>
            </div>

            <details class="bvp5-fold">
                <summary>
                    <span>📋 分P文件清单</span>
                    <span class="bvp5-summary-tip">点击展开 / 折叠</span>
                </summary>

                <div id="bvp5-list" class="bvp5-list">
                    <div class="bvp5-empty">
                        请先识别分P
                    </div>
                </div>

                <div class="bvp5-list-hint">
                    点击 MP4 或 M4A 状态按钮，即可单独下载对应文件。
                </div>
            </details>

            <details class="bvp5-fold">
                <summary>
                    <span>📝 运行日志</span>
                    <span class="bvp5-summary-tip">点击展开 / 折叠</span>
                </summary>

                <div class="bvp5-log-actions">
                    <button id="bvp5-clear-logs">清空日志</button>
                </div>

                <div id="bvp5-logs" class="bvp5-logs">
                    <div class="bvp5-log-item">下载器初始化完成</div>
                </div>
            </details>

            <div class="bvp5-footer">
                MP4 视频流 · M4A 音频流 · 支持单文件与批量下载
            </div>
        </div>
    `;

    // =====================================================
    // 22. CSS 样式
    // =====================================================

    const style = document.createElement('style');

    style.textContent = `
        #bvp5-launcher {
            position:fixed;
            right:24px;
            bottom:24px;
            z-index:999999;
            width:58px;
            height:58px;
            display:flex;
            align-items:center;
            justify-content:center;
            border:0;
            border-radius:19px;
            background:linear-gradient(135deg,#4567ed,#9856d7);
            color:white;
            box-shadow:0 6px 25px #625de080;
            cursor:pointer;
            transition:transform .2s,box-shadow .2s;
        }

        #bvp5-launcher:hover {
            transform:translateY(-3px);
            box-shadow:0 9px 30px #625de099;
        }

        .bvp5-launcher-icon {
            font-size:32px;
            font-weight:800;
        }

        .bvp5-launcher-dot {
            position:absolute;
            top:7px;
            right:7px;
            width:10px;
            height:10px;
            border-radius:50%;
            background:#54e1a0;
            border:2px solid white;
        }

        #bvp5-panel {
            position:fixed;
            right:22px;
            bottom:22px;
            z-index:999999;
            width:420px;
            max-height:88vh;
            display:none;
            flex-direction:column;
            overflow:hidden;
            background:#f7f8fc;
            color:#202438;
            border:1px solid #e9ebf3;
            border-radius:18px;
            box-shadow:0 12px 50px rgba(35,45,90,.22);
            font-family:Arial,"Microsoft YaHei",sans-serif;
            font-size:13px;
            line-height:1.5;
        }

        #bvp5-panel * {
            box-sizing:border-box;
        }

        .bvp5-header {
            flex-shrink:0;
            display:flex;
            justify-content:space-between;
            align-items:center;
            padding:16px 19px;
            color:white;
            background:linear-gradient(120deg,#4361ee,#7955d9,#a15bd0);
        }

        .bvp5-brand {
            display:flex;
            align-items:center;
            gap:11px;
        }

        .bvp5-logo {
            width:38px;
            height:38px;
            display:grid;
            place-items:center;
            border-radius:11px;
            background:#ffffff30;
            font-size:22px;
            font-weight:900;
        }

        .bvp5-heading {
            font-size:16px;
            font-weight:800;
        }

        .bvp5-subheading {
            font-size:10px;
            opacity:.8;
        }

        .bvp5-header-actions button {
            width:30px;
            height:30px;
            border:0;
            border-radius:8px;
            background:#ffffff25;
            color:white;
            font-size:22px;
            cursor:pointer;
        }

        .bvp5-content {
            padding:14px;
            overflow:auto;
        }

        .bvp5-info-card {
            padding:13px;
            background:white;
            border:1px solid #edf0f8;
            border-radius:12px;
        }

        .bvp5-label {
            color:#8a91a5;
            font-size:11px;
        }

        .bvp5-video-title {
            margin-top:3px;
            font-size:15px;
            font-weight:750;
            word-break:break-all;
        }

        .bvp5-meta {
            display:flex;
            justify-content:space-between;
            margin-top:8px;
            color:#8990a5;
            font-size:11px;
        }

        .bvp5-folder {
            display:flex;
            gap:7px;
            margin-top:10px;
            padding:8px;
            background:#f4f6fc;
            border-radius:7px;
            color:#66708c;
            font-size:11px;
            word-break:break-all;
        }

        .bvp5-actions {
            display:grid;
            grid-template-columns:1fr 1fr;
            gap:8px;
            margin:12px 0;
        }

        .bvp5-btn {
            padding:10px 6px;
            border:0;
            border-radius:9px;
            font-size:12px;
            font-weight:700;
            cursor:pointer;
        }

        .bvp5-btn:disabled {
            opacity:.4;
            cursor:not-allowed;
        }

        .bvp5-btn.primary {
            color:white;
            background:linear-gradient(110deg,#4965ed,#7859df);
        }

        .bvp5-btn.secondary {
            color:#515b79;
            background:white;
            border:1px solid #e6e9f2;
        }

        .bvp5-btn.danger {
            color:#df5260;
            background:#fff0f1;
            border:1px solid #ffdddd;
        }

        .bvp5-status {
            margin-bottom:11px;
            padding:10px 12px;
            border-radius:9px;
            background:#edf2ff;
            color:#5268c9;
            font-size:12px;
            word-break:break-all;
        }

        .bvp5-stats {
            display:grid;
            grid-template-columns:repeat(5,1fr);
            gap:5px;
        }

        .bvp5-stat {
            display:flex;
            flex-direction:column;
            align-items:center;
            padding:9px 2px;
            background:white;
            border:1px solid #edf0f8;
            border-radius:9px;
        }

        .bvp5-stat strong {
            font-size:19px;
            color:#313a58;
        }

        .bvp5-stat span {
            font-size:10px;
            color:#9298aa;
        }

        .green {color:#21a879!important;}
        .orange {color:#e39b34!important;}
        .blue {color:#5272e8!important;}
        .red {color:#e25c69!important;}

        .bvp5-section {
            margin-top:13px;
            padding:12px;
            background:white;
            border:1px solid #edf0f8;
            border-radius:12px;
        }

        .bvp5-section-heading {
            display:flex;
            justify-content:space-between;
            align-items:center;
            margin-bottom:10px;
            font-weight:750;
        }

        .bvp5-section-heading strong {
            color:#5d6fe2;
            font-size:15px;
        }

        .bvp5-progress-track {
            height:9px;
            overflow:hidden;
            background:#edf0f8;
            border-radius:20px;
        }

        .bvp5-progress-bar {
            width:0%;
            height:100%;
            background:linear-gradient(90deg,#5274ed,#a05ce0);
            border-radius:20px;
            transition:width .25s;
        }

        .bvp5-muted {
            margin-top:7px;
            color:#969caf;
            font-size:10px;
        }

        .bvp5-current {
            display:flex;
            justify-content:space-between;
            gap:8px;
            margin-top:8px;
            font-size:10px;
            color:#75809d;
        }

        #bvp5-current-file {
            overflow:hidden;
            text-overflow:ellipsis;
            white-space:nowrap;
        }

        #bvp5-speed {
            flex-shrink:0;
            color:#5972dc;
        }

        .bvp5-fold {
            margin-top:12px;
            padding:11px;
            background:white;
            border:1px solid #edf0f8;
            border-radius:11px;
        }

        .bvp5-fold summary {
            display:flex;
            justify-content:space-between;
            align-items:center;
            cursor:pointer;
            list-style:none;
            font-weight:750;
            font-size:12px;
        }

        .bvp5-fold summary::-webkit-details-marker {
            display:none;
        }

        .bvp5-fold summary::after {
            content:'＋';
            color:#7181d8;
            margin-left:7px;
        }

        .bvp5-fold[open] summary::after {
            content:'－';
        }

        .bvp5-summary-tip {
            margin-left:auto;
            color:#a0a6b6;
            font-size:10px;
            font-weight:400;
        }

        .bvp5-list {
            max-height:250px;
            overflow:auto;
            margin-top:10px;
        }

        .bvp5-page-card {
            padding:10px 5px;
            border-bottom:1px solid #f0f1f6;
        }

        .bvp5-page-card:last-child {
            border-bottom:0;
        }

        .bvp5-page-title {
            margin-bottom:7px;
            color:#434c67;
            font-size:11px;
            font-weight:700;
            word-break:break-all;
        }

        .bvp5-file-row {
            display:grid;
            grid-template-columns:1fr 1fr;
            gap:7px;
        }

        .bvp5-file-button {
            display:flex;
            flex-direction:column;
            align-items:flex-start;
            gap:3px;
            min-width:0;
            padding:7px;
            border:1px solid transparent;
            border-radius:7px;
            text-align:left;
            font-size:10px;
            cursor:pointer;
            transition:.15s;
        }

        .bvp5-file-button:hover:not(:disabled) {
            border-color:#b8c3f7;
            transform:translateY(-1px);
        }

        .bvp5-file-button:disabled {
            cursor:default;
            opacity:1;
        }

        .bvp5-file-button.green {
            background:#eaf8f1;
        }

        .bvp5-file-button.orange {
            background:#fff5e5;
        }

        .bvp5-file-button.blue {
            background:#eaf0ff;
        }

        .bvp5-file-button.red {
            background:#ffebed;
        }

        .bvp5-file-state {
            font-size:9px;
            font-weight:700;
        }

        .bvp5-list-hint {
            margin-top:8px;
            color:#969caf;
            font-size:10px;
        }

        .bvp5-log-actions {
            display:flex;
            justify-content:flex-end;
            margin-top:8px;
        }

        #bvp5-clear-logs {
            border:0;
            background:transparent;
            color:#7081d8;
            font-size:10px;
            cursor:pointer;
        }

        .bvp5-logs {
            max-height:120px;
            overflow:auto;
            margin-top:6px;
            padding:7px;
            background:#f7f8fc;
            border-radius:7px;
        }

        .bvp5-log-item {
            padding:4px 0;
            border-bottom:1px solid #eceef4;
            color:#7c849a;
            font-size:10px;
            word-break:break-all;
        }

        .bvp5-empty {
            padding:24px 5px;
            color:#a2a8b8;
            text-align:center;
        }

        .bvp5-footer {
            margin-top:12px;
            color:#a2a8b8;
            font-size:9px;
            text-align:center;
        }

        @media(max-width:500px) {
            #bvp5-panel {
                right:10px;
                bottom:10px;
                width:calc(100vw - 20px);
            }

            #bvp5-launcher {
                right:15px;
                bottom:15px;
            }
        }
    `;

    document.head.appendChild(style);

    // =====================================================
    // 23. 添加到页面
    // =====================================================

    document.body.appendChild(launcher);
    document.body.appendChild(panel);
    // 悬浮图标和折叠按钮事件
    launcher.addEventListener('click', openPanel);

    $('collapse').addEventListener(
        'click',
        collapsePanel
    );

    // =====================================================
    // 24. 事件绑定
    // =====================================================

    $('identify').addEventListener('click', async () => {

        if (running) return;

        $('identify').disabled = true;

        try {

            await identifyPages();

        } catch (error) {

            showError(error.message);

            console.error(error);

        } finally {

            $('identify').disabled = false;
        }
    });

    // =====================================================
    // 扫描按钮：支持重复扫描
    // =====================================================


    $('scan').addEventListener('click', async () => {

        if (running || scanning) return;

        if (!pages.length) {
            showError('请先识别视频分P');
            return;
        }

        scanning = true;

        const scanButton = $('scan');

        scanButton.disabled = true;
        scanButton.textContent = '⏳ 请选择文件夹...';

        try {

            // 关键：清除之前保存的文件夹句柄
            rootHandle = null;
            folderHandle = null;

            // 每次扫描都重新弹出文件夹选择窗口
            await scanFiles();

            log('重新选择目录并完成扫描');

        } catch (error) {

            if (error.name === 'AbortError') {
                status('已取消文件夹选择');
            } else {
                showError('扫描失败：' + error.message);
            }

        } finally {

            scanning = false;

            scanButton.disabled = false;
            scanButton.textContent = '📂 扫描文件';
        }
    });


    $('start').addEventListener(
        'click',
        downloadMissing
    );

    $('stop').addEventListener(
        'click',
        stopDownload
    );

    // 点击任意 MP4 / M4A 文件状态按钮
    $('list').addEventListener('click', event => {

        const button = event.target.closest(
            'button[data-file]'
        );

        if (!button || running) return;

        const filename = button.dataset.file;
        const type = button.dataset.type;

        downloadSingleFile(filename, type);
    });

    $('clear-logs').addEventListener('click', () => {
        $('logs').replaceChildren();
        log('日志已清空');
    });

    // =====================================================
    // 25. 初始化：默认只显示悬浮图标
    // =====================================================

    panel.style.display = 'none';
    launcher.style.display = 'flex';

    log('V5.0 已启动');

    log('当前 BV：' + (getBvid() || '未识别'));

})();
