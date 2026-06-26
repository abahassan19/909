const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ['websocket', 'polling'],
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingInterval: 25000,
  pingTimeout: 60000,
  maxHttpBufferSize: 100 * 1024 * 1024 // 100MB for file transfers
});

app.set('trust proxy', 1);

const clients = new Map(); // uuid -> { socket, cwd, env, lastHeartbeat, connected }
const viewers = new Map(); // uuid -> Set of sockets
const masters = new Set();

const publicDir = path.join(__dirname, 'public-server');
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);

// [Keep the same HTML template as before, no changes needed]

const indexHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Remote Terminal</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body, html { height: 100%; background: #121212; color: #eee; font-family: 'Courier New', monospace; }
    #terminal { padding: 15px; height: calc(95vh - 40px); overflow-y: auto; white-space: pre-wrap; font-size: 13px; line-height: 1.4; }
    #inputLine { position: fixed; bottom: 0; width: 100%; background: #1a1a1a; padding: 8px 15px; border-top: 1px solid #333; }
    #cmd { width: 100%; background: transparent; border: none; color: #0f0; font-family: 'Courier New', monospace; font-size: 13px; }
    #cmd:focus { outline: none; }
    .output { margin: 2px 0; display: flex; gap: 8px; align-items: flex-start; }
    .error { color: #f55; }
    .system { color: #3af; }
    .command { color: #5f5; }
    .lineCheckbox { margin-top: 2px; cursor: pointer; }
    ::-webkit-scrollbar { width: 8px; }
    ::-webkit-scrollbar-track { background: #1a1a1a; }
    ::-webkit-scrollbar-thumb { background: #444; border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: #666; }
    #controlBar { position: fixed; right: 12px; bottom: 72px; background: #1a1a1a; border: 1px solid #333; padding: 10px; border-radius: 6px; display: flex; flex-direction: column; gap: 6px; z-index: 1000; color: #ddd; font-size: 12px; min-width: 280px; max-width: 360px; }
    #selectedList { max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; word-break: break-all; }
    button { background: #2a2a2a; color: #eee; border: 1px solid #333; padding: 6px 8px; border-radius: 4px; cursor: pointer; font-family: 'Courier New', monospace; font-size: 11px; }
    button:hover { background: #3a3a3a; }
    .modeToggle { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
    .modeToggle label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
    .modeToggle input[type="radio"] { accent-color: #0f0; cursor: pointer; }
    .modeLabel { font-weight: bold; }
    .mode-none { color: #aaa; }
    .mode-include { color: #5f5; }
    .mode-exclude { color: #f55; }
    .mode-indicator { padding: 2px 6px; border-radius: 3px; font-size: 10px; font-weight: bold; }
    .mode-indicator.none { background: #aaa2; color: #aaa; border: 1px solid #aaa8; }
    .mode-indicator.include { background: #0f02; color: #5f5; border: 1px solid #0f08; }
    .mode-indicator.exclude { background: #f002; color: #f55; border: 1px solid #f008; }
    .selectedInfo { color: #888; font-size: 10px; }
    .line-highlight { background: #ffffff08; }
    /* File transfer section */
    #fileSection { border-bottom: 1px solid #333; padding-bottom: 6px; margin-bottom: 2px; }
    .file-label { color: #aaa; font-size: 10px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 3px; }
    .file-row { display: flex; gap: 4px; align-items: center; margin-bottom: 4px; }
    .file-row input[type="file"] { font-family: 'Courier New', monospace; font-size: 10px; color: #ddd; width: 100%; }
    .file-row input[type="file"]::-webkit-file-upload-button { background: #2a2a2a; color: #eee; border: 1px solid #333; padding: 4px 6px; border-radius: 4px; cursor: pointer; font-family: 'Courier New', monospace; font-size: 10px; }
    .file-row input[type="file"]::-webkit-file-upload-button:hover { background: #3a3a3a; }
    .file-row input[type="text"] { flex: 1; background: #0a0a0a; border: 1px solid #333; color: #eee; padding: 4px 6px; border-radius: 4px; font-family: 'Courier New', monospace; font-size: 11px; }
    .file-btn { background: #1a3a1a; border: 1px solid #0f08; }
    .file-btn:hover { background: #2a5a2a; }
    .file-btn-small { padding: 4px 6px; font-size: 10px; }
    #fileProgress { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); background: #1a1a1a; border: 1px solid #0f08; padding: 20px; border-radius: 8px; display: none; z-index: 2000; text-align: center; min-width: 320px; }
    #fileProgress .progress-label { margin-bottom: 8px; font-size: 13px; }
    #fileProgress .progress-bar-bg { width: 100%; height: 14px; background: #2a2a2a; border-radius: 7px; overflow: hidden; }
    #fileProgress .progress-bar-fill { height: 100%; width: 0%; background: #0f0; border-radius: 7px; transition: width 0.3s; }
    #fileProgress .progress-pct { margin-top: 6px; font-size: 11px; color: #aaa; }
  </style>
</head>
<body>
  <div id="terminal"></div>
  <div id="controlBar" title="Selection & File Controls">
    <!-- File Transfer Section (top) -->
    <div id="fileSection">
      <div class="file-label">Upload File to Client(s)</div>
<br>
      <div class="file-row">
        <input type="file" id="uploadFileInput" />
      </div>
<br>
      <div class="file-row">
        <button id="uploadBtn" class="file-btn file-btn-small" style="width:100%">Upload</button>
      </div>
<br>
      <div class="file-label" style="margin-top:4px">Download File from Client</div>
<br>
      <div class="file-row">
        <input type="text" id="downloadPath" placeholder="remote file path..." />
        <button id="downloadBtn" class="file-btn file-btn-small">Get</button>
      </div>
<br>
    </div>
    <!-- Mode Selection Section (bottom) -->
    <div class="modeToggle">
      <span class="modeLabel">Mode:</span>
      <label><input type="radio" name="selMode" value="none" checked /> <span class="mode-none">None</span></label>
      <label><input type="radio" name="selMode" value="include" /> <span class="mode-include">Include</span></label>
      <label><input type="radio" name="selMode" value="exclude" /> <span class="mode-exclude">Exclude</span></label>
      <span id="modeBadge" class="mode-indicator none">NONE</span>
    </div>
    <div id="selectedList" class="selectedInfo">All clients targeted</div>
    <button id="clearBtn">Clear Selections</button>
  </div>
  <div id="fileProgress">
    <div class="progress-label" id="progressLabel">Transferring...</div>
    <div class="progress-bar-bg"><div class="progress-bar-fill" id="progressFill"></div></div>
    <div class="progress-pct" id="progressPct">0%</div>
  </div>
  <div id="inputLine">
    <input type="text" id="cmd" autocomplete="off" spellcheck="false" placeholder="Type command..." autofocus />
  </div>
  <script src="/socket.io/socket.io.js"></script>
  <script>
    let socket = null;
    const terminal = document.getElementById('terminal');
    const input = document.getElementById('cmd');
    const selectedUUIDs = new Set();
    const excludedUUIDs = new Set();
    let selectionMode = 'none';
    let commandHistory = [];
    let historyIndex = -1;
    let lastCtrlClickedCheckbox = null;
    // File transfer state
    let downloadMeta = null;
    let pendingDownloadChunks = {};

    // Radio button listeners for mode toggle
    document.querySelectorAll('input[name="selMode"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        if (e.target.checked) {
          selectionMode = e.target.value;
          const badge = document.getElementById('modeBadge');
          badge.textContent = selectionMode.toUpperCase();
          badge.className = 'mode-indicator ' + selectionMode;
          updateSelectedList();

          document.querySelectorAll('.lineCheckbox').forEach(cb => {
            cb.disabled = (selectionMode === 'none');
          });
        }
      });
    });

    function updateSelectedList() {
      const el = document.getElementById('selectedList');
      if (selectionMode === 'none') {
        el.textContent = 'Mode: None — all clients targeted via normal input';
      } else if (selectionMode === 'include') {
        if (selectedUUIDs.size === 0) el.textContent = 'Selected (include): none — command will go nowhere';
        else el.textContent = 'Selected (include): ' + Array.from(selectedUUIDs).join(', ');
      } else {
        if (excludedUUIDs.size === 0) el.textContent = 'Excluded: none — all clients targeted';
        else el.textContent = 'Excluded: ' + Array.from(excludedUUIDs).join(', ');
      }
    }

    function getAllVisibleUUIDs() {
      const uuids = new Set();
      document.querySelectorAll('.lineCheckbox:not(:disabled)').forEach(cb => {
        if (cb.dataset.uuid) uuids.add(cb.dataset.uuid);
      });
      return uuids;
    }

    function getTargetUUIDs() {
      if (selectionMode === 'none') {
        return null;
      } else if (selectionMode === 'include') {
        return new Set(selectedUUIDs);
      } else {
        const all = getAllVisibleUUIDs();
        excludedUUIDs.forEach(id => all.delete(id));
        return all;
      }
    }

    function makeLineElement(text, cls) {
      const wrapper = document.createElement('div');
      wrapper.className = 'output';
      if (cls) wrapper.classList.add(cls);
      const uuidMatch = text.match(/^\\[([0-9a-fA-F-]{8,36})\\]/);
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'lineCheckbox';
      if (uuidMatch) {
        checkbox.dataset.uuid = uuidMatch[1];
        checkbox.disabled = (selectionMode === 'none');
        checkbox.addEventListener('change', (e) => {
          const id = e.target.dataset.uuid;
          if (selectionMode === 'include') {
            if (e.target.checked) selectedUUIDs.add(id);
            else selectedUUIDs.delete(id);
          } else if (selectionMode === 'exclude') {
            if (e.target.checked) excludedUUIDs.add(id);
            else excludedUUIDs.delete(id);
          }
          updateSelectedList();
        });
        checkbox.addEventListener('click', (e) => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            const currentCb = e.target;
            if (lastCtrlClickedCheckbox && lastCtrlClickedCheckbox !== currentCb) {
              const allCheckboxes = Array.from(document.querySelectorAll('.lineCheckbox:not(:disabled)'));
              const startIdx = allCheckboxes.indexOf(lastCtrlClickedCheckbox);
              const endIdx = allCheckboxes.indexOf(currentCb);
              if (startIdx !== -1 && endIdx !== -1) {
                const [lo, hi] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
                for (let i = lo; i <= hi; i++) {
                  const cb = allCheckboxes[i];
                  const id = cb.dataset.uuid;
                  if (!id) continue;
                  cb.checked = true;
                  if (selectionMode === 'include') selectedUUIDs.add(id);
                  else if (selectionMode === 'exclude') excludedUUIDs.add(id);
                }
                updateSelectedList();
              }
            }
            lastCtrlClickedCheckbox = currentCb;
          } else {
            lastCtrlClickedCheckbox = null;
          }
        });
      } else {
        checkbox.disabled = true;
        checkbox.title = 'No UUID on this line';
      }
      const textDiv = document.createElement('div');
      textDiv.textContent = text;
      wrapper.appendChild(checkbox);
      wrapper.appendChild(textDiv);
      return wrapper;
    }

    function appendLine(text, cls) {
      const el = makeLineElement(text, cls);
      terminal.appendChild(el);
      terminal.scrollTop = terminal.scrollHeight;
    }

    function showProgress(label, pct) {
      document.getElementById('progressLabel').textContent = label;
      document.getElementById('progressFill').style.width = pct + '%';
      document.getElementById('progressPct').textContent = pct + '%';
      document.getElementById('fileProgress').style.display = 'block';
    }

    function hideProgress() {
      document.getElementById('fileProgress').style.display = 'none';
    }

    socket = io({
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity
    });

    socket.on('connect', () => {
      appendLine('[System] Connected to server', 'system');
      const pathName = window.location.pathname;
      if (pathName === '/master') {
        socket.emit('register-master');
      } else {
        const uuid = (pathName || '/').substring(1);
        if (uuid && uuid !== '') {
          socket.emit('register-viewer', uuid);
        }
      }
    });

    socket.on('connect_error', (error) => { appendLine('[System] Connection error: ' + (error.message || 'Unknown error'), 'error'); });
    socket.on('disconnect', (reason) => { appendLine('[System] Disconnected from server: ' + reason, 'error'); });
    socket.on('output', data => { appendLine(data); });
    socket.on('error', data => { appendLine(data, 'error'); });
    socket.on('system', data => { appendLine(data, 'system'); });
    socket.on('command', data => { appendLine('> ' + data, 'command'); });
    socket.on('directory', dir => { document.title = 'Remote Terminal - ' + dir; });
    socket.on('registered', id => { appendLine('[System] Registered with ID: ' + id, 'system'); });

    // ---- File Download Events ----
    socket.on('download-start', (meta) => {
      downloadMeta = meta;
      pendingDownloadChunks = {};
      showProgress('Downloading: ' + meta.name, 0);
      appendLine('[System] Starting download of "' + meta.name + '" (' + meta.size + ' bytes)', 'system');
    });

    socket.on('download-chunk', (data) => {
      if (!downloadMeta) return;
      pendingDownloadChunks[data.index] = data.chunk;
      const received = Object.keys(pendingDownloadChunks).length;
      const pct = Math.round((received / downloadMeta.totalChunks) * 100);
      showProgress('Downloading: ' + downloadMeta.name, Math.min(pct, 99));
    });

    socket.on('download-end', () => {
      if (!downloadMeta) return;
      hideProgress();
      // Reassemble base64 chunks
      let binary = '';
      for (let i = 0; i < downloadMeta.totalChunks; i++) {
        if (pendingDownloadChunks[i]) {
          binary += pendingDownloadChunks[i];
        }
      }
      // Convert base64 to bytes and trigger browser download
      try {
        const byteChars = atob(binary);
        const bytes = new Uint8Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) {
          bytes[i] = byteChars.charCodeAt(i);
        }
        const blob = new Blob([bytes]);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = downloadMeta.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        appendLine('[System] Downloaded "' + downloadMeta.name + '" (' + downloadMeta.size + ' bytes)', 'system');
      } catch (e) {
        appendLine('[System] Download reassembly error: ' + e.message, 'error');
      }
      downloadMeta = null;
      pendingDownloadChunks = {};
    });

    socket.on('download-error', (msg) => {
      hideProgress();
      appendLine('[System] Download error: ' + msg, 'error');
      downloadMeta = null;
      pendingDownloadChunks = {};
    });

    // ---- File Upload Events ----
    socket.on('upload-complete', (data) => {
      hideProgress();
      appendLine('[System] Uploaded "' + data.name + '" to client(s) (' + data.size + ' bytes)', 'system');
    });

    socket.on('upload-error', (msg) => {
      hideProgress();
      appendLine('[System] Upload error: ' + msg, 'error');
    });

    // Upload progress from client (for multi-client tracking, just show generic)
    socket.on('upload-progress', (data) => {
      showProgress('Uploading: ' + data.name, data.pct);
    });

    input.addEventListener('keydown', evt => {
      if (!socket || !socket.connected) return;
      if (evt.key === 'Enter') {
        const val = input.value.trim();
        if (val) {
          const targets = getTargetUUIDs();

          if (targets === null) {
            socket.emit('command', val);
          } else if (targets.size > 0) {
            socket.emit('targeted-command', { uuids: Array.from(targets), cmd: val });
            appendLine('[System] Sent targeted command to ' + targets.size + ' client(s): ' + val, 'system');
          } else {
            appendLine('[System] No target clients selected — command not sent', 'error');
          }

          commandHistory.push(val);
          historyIndex = commandHistory.length;
        }
        input.value = '';
      } else if (evt.key === 'ArrowUp') {
        evt.preventDefault();
        if (commandHistory.length && historyIndex > 0) {
          historyIndex--;
          input.value = commandHistory[historyIndex];
        }
      } else if (evt.key === 'ArrowDown') {
        evt.preventDefault();
        if (commandHistory.length && historyIndex < commandHistory.length - 1) {
          historyIndex++;
          input.value = commandHistory[historyIndex];
        } else {
          historyIndex = commandHistory.length;
          input.value = '';
        }
      }
    });

    document.getElementById('clearBtn').addEventListener('click', () => {
      selectedUUIDs.clear();
      excludedUUIDs.clear();
      document.querySelectorAll('.lineCheckbox').forEach(cb => { cb.checked = false; });
      lastCtrlClickedCheckbox = null;
      updateSelectedList();
    });

    // ---- File Upload Handler (uses selection mode) ----
    document.getElementById('uploadBtn').addEventListener('click', () => {
      const fileInput = document.getElementById('uploadFileInput');
      if (!fileInput.files || fileInput.files.length === 0) {
        appendLine('[System] No file selected for upload', 'error');
        return;
      }
      const file = fileInput.files[0];
      const targets = getTargetUUIDs();

      const reader = new FileReader();
      reader.onload = function(e) {
        const base64 = e.target.result.split(',')[1];
        const chunkSize = 64 * 1024; // 64KB base64 chunks
        const totalChunks = Math.ceil(base64.length / chunkSize);
        const uploadId = Date.now() + '-' + Math.random().toString(36).substr(2, 6);

        const meta = {
          uploadId,
          name: file.name,
          size: file.size,
          totalChunks,
          chunkSize,
          targets: targets ? Array.from(targets) : null
        };

        socket.emit('upload-start', meta);

        let sent = 0;
        function sendNext() {
          if (sent >= totalChunks) {
            socket.emit('upload-end', { uploadId, targets: targets ? Array.from(targets) : null });
            return;
          }
          const chunk = base64.substring(sent * chunkSize, (sent + 1) * chunkSize);
          socket.emit('upload-chunk', { uploadId, index: sent, chunk, targets: targets ? Array.from(targets) : null });
          sent++;
          const pct = Math.round((sent / totalChunks) * 100);
          showProgress('Uploading: ' + file.name, pct);
          setTimeout(sendNext, 10);
        }
        sendNext();
      };
      reader.readAsDataURL(file);
    });

    // ---- File Download Handler (uses selection mode) ----
    document.getElementById('downloadBtn').addEventListener('click', () => {
      const remotePath = document.getElementById('downloadPath').value.trim();
      if (!remotePath) {
        appendLine('[System] No remote path specified for download', 'error');
        return;
      }
      const targets = getTargetUUIDs();

      if (targets === null) {
        // None mode: pick first client (server will handle this)
        socket.emit('download-request', { path: remotePath, targets: null });
        appendLine('[System] Requested download of "' + remotePath + '" from first available client', 'system');
      } else if (targets.size > 0) {
        const targetArr = Array.from(targets);
        socket.emit('download-request', { path: remotePath, targets: targetArr });
        appendLine('[System] Requested download of "' + remotePath + '" from ' + targetArr.length + ' client(s)', 'system');
      } else {
        appendLine('[System] No target clients selected for download', 'error');
      }
    });

    // Initialize
    document.querySelectorAll('.lineCheckbox').forEach(cb => { cb.disabled = true; });
    updateSelectedList();
  </script>
</body>
</html>`;

fs.writeFileSync(path.join(publicDir, 'index.html'), indexHtml);

app.get('/master', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.get('/:uuid', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Cleanup stale clients periodically
setInterval(() => {
  const now = Date.now();
  for (const [uuid, data] of clients.entries()) {
    if (!data.socket || !data.socket.connected) {
      if (now - data.lastHeartbeat > 120000) { // 2 minutes without heartbeat
        console.log(`[Server] Cleaning up stale client: ${uuid}`);
        clients.delete(uuid);
        viewers.delete(uuid);
      }
    }
  }
}, 60000);

// Socket.io handling
io.on('connection', (socket) => {
  let role = null;
  let clientId = null;

  socket.on('register-client', (data) => {
    role = 'client';
    const oldId = data?.clientId;
    const epoch = data?.epoch || Date.now();

    // Generate or reuse client ID
    if (oldId && clients.has(oldId)) {
      const existing = clients.get(oldId);
      // Only reuse if the old client is actually disconnected
      if (!existing.socket || !existing.socket.connected) {
        clientId = oldId;
      } else {
        // If still connected, generate new ID to avoid conflicts
        clientId = uuidv4();
      }
    } else {
      clientId = oldId || uuidv4();
    }

    // Store client data
    clients.set(clientId, {
      socket,
      epoch: epoch,
      lastHeartbeat: Date.now(),
      cwd: process.platform === 'win32' ? process.env.USERPROFILE || process.cwd() : process.cwd(),
      env: {}
    });

    console.log(`[Server] Client registered: ${clientId}`);
    socket.emit('registered', clientId);

    const clientData = clients.get(clientId);
    socket.emit('directory', clientData.cwd);

    // Set up event handlers
    socket.on('heartbeat', () => {
      const data = clients.get(clientId);
      if (data) {
        data.lastHeartbeat = Date.now();
      }
    });

    socket.on('disconnect', () => {
      console.log(`[Server] Client ${clientId} disconnected`);
      
      // Notify viewers and masters
      const viewersSet = viewers.get(clientId);
      if (viewersSet) {
        viewersSet.forEach(s => {
          s.emit('system', `[System] Client ${clientId} disconnected`);
        });
      }
      masters.forEach(ms => {
        ms.emit('system', `[System] Client ${clientId} disconnected`);
      });

      // Don't delete the client entry immediately, allow for reconnection
      // The cleanup interval will handle stale entries
    });

    // Forward events to viewers and masters
    socket.on('output', (data) => {
      const viewersSet = viewers.get(clientId);
      if (viewersSet) {
        viewersSet.forEach(s => s.emit('output', `[${clientId}] ${data}`));
      }
      masters.forEach(ms => ms.emit('output', `[${clientId}] ${data}`));
    });

    socket.on('error', (data) => {
      const viewersSet = viewers.get(clientId);
      if (viewersSet) {
        viewersSet.forEach(s => s.emit('error', `[${clientId}] ${data}`));
      }
      masters.forEach(ms => ms.emit('error', `[${clientId}] ${data}`));
    });

    socket.on('directory', (dir) => {
      const viewersSet = viewers.get(clientId);
      if (viewersSet) {
        viewersSet.forEach(s => s.emit('directory', dir));
      }
      masters.forEach(ms => ms.emit('system', `[${clientId}] Directory changed to: ${dir}`));
    });

    socket.on('run-command', (cmd) => {
      socket.emit('command', cmd);
    });

    // File transfer events
    socket.on('file-download-start', (meta) => {
      const viewersSet = viewers.get(clientId);
      if (viewersSet) {
        viewersSet.forEach(s => s.emit('download-start', meta));
      }
      masters.forEach(ms => ms.emit('download-start', meta));
    });

    socket.on('file-download-chunk', (data) => {
      const viewersSet = viewers.get(clientId);
      if (viewersSet) {
        viewersSet.forEach(s => s.emit('download-chunk', data));
      }
      masters.forEach(ms => ms.emit('download-chunk', data));
    });

    socket.on('file-download-end', (data) => {
      const viewersSet = viewers.get(clientId);
      if (viewersSet) {
        viewersSet.forEach(s => s.emit('download-end'));
      }
      masters.forEach(ms => ms.emit('download-end'));
    });

    socket.on('file-download-error', (msg) => {
      const viewersSet = viewers.get(clientId);
      if (viewersSet) {
        viewersSet.forEach(s => s.emit('download-error', msg));
      }
      masters.forEach(ms => ms.emit('download-error', msg));
    });

    socket.on('file-uploaded', (data) => {
      const viewersSet = viewers.get(clientId);
      if (viewersSet) {
        viewersSet.forEach(s => s.emit('upload-complete', data));
      }
      masters.forEach(ms => ms.emit('upload-complete', data));
    });

    socket.on('file-upload-error', (msg) => {
      const viewersSet = viewers.get(clientId);
      if (viewersSet) {
        viewersSet.forEach(s => s.emit('upload-error', msg));
      }
      masters.forEach(ms => ms.emit('upload-error', msg));
    });

    socket.on('upload-progress', (data) => {
      const viewersSet = viewers.get(clientId);
      if (viewersSet) {
        viewersSet.forEach(s => s.emit('upload-progress', data));
      }
      masters.forEach(ms => ms.emit('upload-progress', data));
    });
  });

  socket.on('register-viewer', (id) => {
    role = 'viewer';
    clientId = id;
    
    if (!clients.has(clientId)) {
      socket.emit('system', '[System] Error: Client not connected or invalid UUID');
      return;
    }

    if (!viewers.has(clientId)) {
      viewers.set(clientId, new Set());
    }
    viewers.get(clientId).add(socket);

    const clientData = clients.get(clientId);
    socket.emit('system', `[System] Connected to client ${clientId}`);
    socket.emit('directory', clientData.cwd);

    socket.on('command', (cmd) => {
      if (clientData.socket && clientData.socket.connected) {
        clientData.socket.emit('run-command', cmd);
        socket.emit('command', cmd);
      } else {
        socket.emit('system', `[System] Client ${clientId} is not connected`);
      }
    });

    socket.on('disconnect', () => {
      const set = viewers.get(clientId);
      if (set) {
        set.delete(socket);
        if (set.size === 0) {
          viewers.delete(clientId);
        }
      }
    });

    // Upload events from viewer
    socket.on('upload-start', (meta) => {
      if (clientData.socket && clientData.socket.connected) {
        clientData.socket.emit('file-upload-start', meta);
      }
    });

    socket.on('upload-chunk', (data) => {
      if (clientData.socket && clientData.socket.connected) {
        clientData.socket.emit('file-upload-chunk', data);
      }
    });

    socket.on('upload-end', (data) => {
      if (clientData.socket && clientData.socket.connected) {
        clientData.socket.emit('file-upload-end', data);
      }
    });

    // Download events from viewer
    socket.on('download-request', (data) => {
      if (clientData.socket && clientData.socket.connected) {
        clientData.socket.emit('file-download-request', { path: data.path });
      } else {
        socket.emit('download-error', 'Client is not connected');
      }
    });
  });

  socket.on('register-master', () => {
    role = 'master';
    masters.add(socket);
    socket.emit('system', `[System] Registered as master terminal`);
    console.log('[Server] Master terminal connected');

    socket.on('command', (cmd) => {
      clients.forEach(({ socket: clientSocket }) => {
        if (clientSocket && clientSocket.connected) {
          clientSocket.emit('run-command', cmd);
        }
      });
      socket.emit('command', cmd);
    });

    socket.on('disconnect', () => {
      masters.delete(socket);
      console.log('[Server] Master terminal disconnected');
    });

    // Upload events from master (with include/exclude support)
    socket.on('upload-start', (meta) => {
      if (meta.targets === null) {
        // Broadcast to ALL clients
        clients.forEach((client, id) => {
          if (client.socket && client.socket.connected) {
            client.socket.emit('file-upload-start', meta);
          }
        });
      } else {
        // Only targeted clients
        meta.targets.forEach(id => {
          const client = clients.get(id);
          if (client && client.socket && client.socket.connected) {
            client.socket.emit('file-upload-start', meta);
          }
        });
      }
    });

    socket.on('upload-chunk', (data) => {
      if (data.targets === null) {
        clients.forEach((client, id) => {
          if (client.socket && client.socket.connected) {
            client.socket.emit('file-upload-chunk', data);
          }
        });
      } else {
        data.targets.forEach(id => {
          const client = clients.get(id);
          if (client && client.socket && client.socket.connected) {
            client.socket.emit('file-upload-chunk', data);
          }
        });
      }
    });

    socket.on('upload-end', (data) => {
      if (data.targets === null) {
        clients.forEach((client, id) => {
          if (client.socket && client.socket.connected) {
            client.socket.emit('file-upload-end', data);
          }
        });
      } else {
        data.targets.forEach(id => {
          const client = clients.get(id);
          if (client && client.socket && client.socket.connected) {
            client.socket.emit('file-upload-end', data);
          }
        });
      }
    });

    // Download events from master
    socket.on('download-request', (data) => {
      if (data.targets === null || data.targets.length === 0) {
        // Pick first available client
        const firstEntry = clients.entries().next().value;
        if (firstEntry) {
          const [id, client] = firstEntry;
          if (client.socket && client.socket.connected) {
            client.socket.emit('file-download-request', { path: data.path });
          } else {
            socket.emit('download-error', 'No connected clients available');
          }
        } else {
          socket.emit('download-error', 'No connected clients available');
        }
      } else {
        // Use first targeted client for download
        const targetId = data.targets[0];
        const client = clients.get(targetId);
        if (client && client.socket && client.socket.connected) {
          client.socket.emit('file-download-request', { path: data.path });
        } else {
          socket.emit('download-error', 'Target client [' + targetId + '] not connected');
        }
      }
    });
  });

  // Targeted-command handling
  socket.on('targeted-command', ({ uuids, cmd }) => {
    if (!Array.isArray(uuids) || typeof cmd !== 'string' || cmd.trim() === '') {
      socket.emit('system', '[System] Invalid targeted command payload');
      return;
    }
    uuids.forEach(id => {
      const client = clients.get(id);
      if (client && client.socket && client.socket.connected) {
        client.socket.emit('run-command', cmd);
      } else {
        socket.emit('system', `[System] Client ${id} unavailable or not connected`);
      }
    });
    socket.emit('command', cmd);
  });
});

const PORT = 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Listening on http://localhost:${PORT}`);
  console.log(`[Server] Clients can connect to ws://localhost:${PORT}`);
});
