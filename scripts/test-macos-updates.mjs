#!/usr/bin/env node
/** Isolated Squirrel.Mac boundary proof. Never starts LocalScribe or uses its profile. */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const run = (file, args) => execute(file, args, { timeout: 45_000, maxBuffer: 1024 * 1024 });
assert.equal(process.platform, 'darwin', 'Native updater fixture requires macOS');
const source = path.resolve(createRequire(import.meta.url)('electron'), '../../..');
assert.equal(path.basename(source), 'Electron.app');
assert.equal((await readFile(path.resolve(source, '..', 'version'), 'utf8')).trim(), '43.7.7');
const identity = process.env.LOCALSCRIBE_CODESIGN_IDENTITY;
assert.ok(identity?.startsWith('Developer ID Application: '), 'Set LOCALSCRIBE_CODESIGN_IDENTITY to an approved Developer ID Application identity');
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'localscribe-native-updates-')));
const evidence = await mkdtemp('/tmp/localscribe-native-update-evidence-');
const bundleId = 'com.localscribe.updater-test.' + randomUUID().slice(0, 8);
const appPath = path.join(root, 'installed', 'Updater Fixture.app');
const targetPath = path.join(root, 'release', 'Updater Fixture.app');
const archive = path.join(root, 'update.zip');
const profile = path.join(root, 'profile');
const receiptFile = path.join(evidence, 'receipt.jsonl');
const events = [];
let child;
let childClosed;
let deadline;
let receivedNewVersion;
let failed;
const finished = new Promise((resolve, reject) => { receivedNewVersion = resolve; failed = reject; });
// Install the rejection observer before signing/launching; failures remain bounded.
finished.catch(() => {});
const server = createServer(async (request, response) => {
  try {
    if (request.method === 'POST' && request.url === '/receipt') {
      let body = '';
      for await (const chunk of request) { body += chunk; if (body.length > 32768) throw new Error('Oversized fixture receipt'); }
      const event = JSON.parse(body);
      events.push(event);
      await appendFile(receiptFile, JSON.stringify(event) + '\n');
      response.writeHead(200).end('ok');
      if (event.event === 'error') failed(new Error(event.message));
      if (event.event === 'new-version-exiting' && event.version === '0.1.1') receivedNewVersion(events.find(entry => entry.event === 'launched' && entry.version === '0.1.1'));
    } else if (request.method === 'GET' && request.url === '/feed') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ url: origin + '/update.zip', name: '0.1.1', notes: 'Isolated signed fixture', pub_date: '2026-10-19T00:00:00Z' }));
    } else if (request.method === 'GET' && request.url === '/update.zip') {
      response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': (await stat(archive)).size });
      createReadStream(archive).pipe(response);
    } else { response.writeHead(404).end(); }
  } catch (error) { response.writeHead(500).end(); failed(error); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = 'http://127.0.0.1:' + server.address().port;
const entitlements = path.join(root, 'entitlements.plist');
await writeFile(entitlements, '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>');

async function makeApp(destination, version) {
  await mkdir(path.dirname(destination), { recursive: true });
  await run('/usr/bin/ditto', [source, destination]);
  await rename(path.join(destination, 'Contents/MacOS/Electron'), path.join(destination, 'Contents/MacOS/Updater Fixture'));
  const resources = path.join(destination, 'Contents/Resources');
  await rm(path.join(resources, 'default_app.asar'), { force: true });
  await mkdir(path.join(resources, 'app'));
  await writeFile(path.join(resources, 'app/package.json'), JSON.stringify({ name: 'isolated-updater-fixture', version, main: 'main.cjs' }));
  await writeFile(path.join(resources, 'app/main.cjs'), `
const {app,autoUpdater,BrowserWindow}=require('electron');
const http=require('node:http');
const root=${JSON.stringify(root)},origin=${JSON.stringify(origin)},expectedPath=${JSON.stringify(appPath)};
app.setPath('userData',${JSON.stringify(profile)});
app.setPath('cache',root+'/cache');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
const receipt=(event,extra={})=>new Promise((resolve,reject)=>{
 const data=JSON.stringify({event,version:app.getVersion(),pid:process.pid,execPath:process.execPath,...extra});
 const request=http.request(origin+'/receipt',{method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(data)}},response=>{response.resume();response.on('end',resolve)});
 request.on('error',reject);request.end(data);
});
process.on('uncaughtException',error=>void receipt('error',{message:error.stack}).finally(()=>app.exit(1)));
app.whenReady().then(async()=>{
 app.setActivationPolicy('prohibited');
 if(!process.execPath.startsWith(expectedPath+'/Contents/')) throw new Error('Unexpected fixture install path');
 const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}});
 await receipt('launched',{packaged:app.isPackaged,electron:process.versions.electron,userData:app.getPath('userData'),visible:window.isVisible()});
 if(app.getVersion()==='0.1.1'){await receipt('new-version-exiting');app.exit(0);return;}
 autoUpdater.on('error',error=>void receipt('error',{message:error.stack}).finally(()=>app.exit(1)));
 autoUpdater.on('checking-for-update',()=>void receipt('checking'));
 autoUpdater.on('update-available',()=>void receipt('available'));
 autoUpdater.on('update-not-available',()=>void receipt('error',{message:'Fixture unexpectedly returned no update'}).finally(()=>app.exit(1)));
 autoUpdater.once('update-downloaded',async()=>{
  await receipt('downloaded');
  await receipt('quitAndInstall-called');
  autoUpdater.quitAndInstall();
 });
 autoUpdater.on('before-quit-for-update',()=>void receipt('before-quit-for-update'));
 autoUpdater.setFeedURL({url:origin+'/feed',serverType:'default',headers:{Accept:'application/json'}});
 autoUpdater.checkForUpdates();
}).catch(error=>void receipt('error',{message:error.stack}).finally(()=>app.exit(1)));
`);
  const plist = path.join(destination, 'Contents/Info.plist');
  for (const [key, value] of Object.entries({ CFBundleExecutable: 'Updater Fixture', CFBundleIdentifier: bundleId, CFBundleName: 'Updater Fixture', CFBundleDisplayName: 'Updater Fixture', CFBundleShortVersionString: version, CFBundleVersion: version })) {
    await run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
  }
  await run('/usr/libexec/PlistBuddy', ['-c', 'Add :LSUIElement bool true', plist]);
  await run('/usr/libexec/PlistBuddy', ['-c', 'Delete :ElectronAsarIntegrity', plist]);
  // Sign only owned copies. No identity listing, keychain inspection or timestamp network request.
  await run(process.execPath, ['-e', `require('@electron/osx-sign').signAsync({app:${JSON.stringify(destination)},identity:${JSON.stringify(identity)},platform:'darwin',identityValidation:false,preAutoEntitlements:false,preEmbedProvisioningProfile:false,ignore:file=>{const fs=require('node:fs');if(!fs.statSync(file).isFile())return false;const fd=fs.openSync(file,'r'),magic=Buffer.alloc(4);try{fs.readSync(fd,magic,0,4,0)}finally{fs.closeSync(fd)}return !['cffaedfe','cefaedfe','cafebabe','bebafeca','feedfacf','feedface'].includes(magic.toString('hex'))},optionsForFile:()=>({entitlements:${JSON.stringify(entitlements)},timestamp:'none',hardenedRuntime:true})}).catch(error=>{console.error(error);process.exitCode=1})`]);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', destination]);
  const signature = await run('/usr/bin/codesign', ['-d', '-r-', '--verbose=2', destination]);
  const description = signature.stdout + signature.stderr;
  assert.match(description, /TeamIdentifier=[A-Z0-9]{10}/);
  assert.ok(description.includes(bundleId));
  await writeFile(path.join(evidence, 'signature-' + version + '.txt'), description);
  return description.match(/designated => (.*)/)?.[1];
}

try {
  const oldRequirement = await makeApp(appPath, '0.1.0');
  const newRequirement = await makeApp(targetPath, '0.1.1');
  assert.ok(oldRequirement && oldRequirement === newRequirement, 'Fixture code identities must match');
  await run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', targetPath, archive]);
  await mkdir(path.join(root, 'home'), { recursive: true });
  const env = { ...process.env, CFFIXED_USER_HOME: path.join(root, 'home') };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(path.join(appPath, 'Contents/MacOS/Updater Fixture'), [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => void appendFile(path.join(evidence, 'child.log'), data));
  child.stderr.on('data', data => void appendFile(path.join(evidence, 'child.log'), data));
  childClosed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  childClosed.then(exit => { if (exit.code !== 0 || exit.signal !== null || !events.some(event => event.event === 'quitAndInstall-called')) failed(new Error('Original fixture exited before successful update: ' + JSON.stringify(exit))); }, failed);
  deadline = setTimeout(() => failed(new Error('Native fixture exceeded 100 seconds; no GUI or permission interaction attempted')), 100_000);
  const relaunched = await finished;
  const exit = await Promise.race([childClosed, finished.then(() => new Promise((_, reject) => setTimeout(() => reject(new Error('Original fixture process did not exit')), 5000)))]);
  assert.deepEqual(exit, { code: 0, signal: null });
  await waitForOwnedExit(relaunched.pid, false);
  assert.equal(relaunched.packaged, true);
  assert.equal(relaunched.visible, false);
  assert.equal(relaunched.electron, '43.7.7');
  assert.equal(relaunched.userData, profile);
  assert.equal(relaunched.execPath, path.join(appPath, 'Contents/MacOS/Updater Fixture'));
  assert.ok(events.some(event => event.event === 'downloaded' && event.version === '0.1.0'));
  assert.ok(events.some(event => event.event === 'quitAndInstall-called'));
  const installedVersion = await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(appPath, 'Contents/Info.plist')]);
  assert.equal(installedVersion.stdout.trim(), '0.1.1');
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ passed: true, bundleId, root, origin, originalExit: exit, relaunched, installedVersion: '0.1.1', matchingCodeIdentity: true, events }, null, 2));
  console.log(JSON.stringify({ passed: true, evidence, bundleId, installedVersion: '0.1.1' }));
} catch (error) {
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ passed: false, error: error.stack, bundleId, root, origin, events }, null, 2));
  console.error('Native fixture failed; evidence: ' + evidence);
  throw error;
} finally {
  clearTimeout(deadline);
  try {
    for (const owned of await ownedProcesses()) await waitForOwnedExit(owned.pid, true);
    if (childClosed) await childClosed;
    const remaining = await ownedProcesses();
    assert.deepEqual(remaining, [], 'Owned fixture processes remain after cleanup');
    await rm(root, { recursive: true, force: true });
    await rm(path.join(homedir(), 'Library/Caches', bundleId + '.ShipIt'), { recursive: true, force: true });
  } finally {
    // Even a process-inspection failure must release the owned HTTP listener.
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await writeFile(path.join(evidence, 'cleanup.json'), JSON.stringify({ processesRemaining: await ownedProcesses(), rootRemoved: await stat(root).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error; }), portClosed: !server.listening }, null, 2));
  }
}

async function ownedProcesses() {
  const result = await run('/bin/ps', ['-axo', 'pid=,command=']);
  return result.stdout.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match) return [];
    const pid = Number(match[1]);
    if (pid <= 1 || pid === process.pid || !(match[2].includes(root + '/') || match[2].includes(bundleId))) return [];
    return [{ pid, command: match[2] }];
  });
}

async function waitForOwnedExit(pid, terminate) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid);
  // kqueue observes native exit even when Squirrel launches outside the child tree.
  // ESRCH on registration proves that the process already exited. Timers only fail a stalled exit.
  const code = `import os,sys,select,signal,subprocess
pid=int(sys.argv[1]);root=sys.argv[2];bundle=sys.argv[3];terminate=sys.argv[4]=='true'
try:
 command=subprocess.check_output(['/bin/ps','-p',str(pid),'-o','command='],text=True).strip()
except subprocess.CalledProcessError:
 sys.exit(0)
if root+'/' not in command and bundle not in command: raise RuntimeError('Refusing unrelated PID')
queue=select.kqueue()
try:
 try: queue.control([select.kevent(pid,filter=select.KQ_FILTER_PROC,flags=select.KQ_EV_ADD|select.KQ_EV_ONESHOT,fflags=select.KQ_NOTE_EXIT)],0,0)
 except ProcessLookupError: sys.exit(0)
 if terminate:
  try: os.kill(pid,signal.SIGTERM)
  except ProcessLookupError: sys.exit(0)
 if not queue.control([],1,5):
  if not terminate: raise RuntimeError('New fixture process did not exit')
  os.kill(pid,signal.SIGKILL)
  if not queue.control([],1,5): raise RuntimeError('Owned fixture process did not exit after SIGKILL')
finally:
 queue.close()
`;
  await run('/usr/bin/python3', ['-c', code, String(pid), root, bundleId, String(terminate)]);
}
