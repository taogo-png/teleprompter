import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated, Modal, PanResponder, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import {
  Camera, CommonDynamicRanges, CommonResolutions, useCameraDevice, useCameraPermission,
  useMicrophonePermission, useVideoOutput,
} from 'react-native-vision-camera';
import { useKeepAwake } from 'expo-keep-awake';
import * as Sharing from 'expo-sharing';
import * as Network from 'expo-network';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

const PORT = 3333;
const DEMO =
  'Bem-vindo ao teleprompter.\n\nAbra o painel no PC e cole o roteiro lá. Ele chega aqui na hora.\n\n' +
  'Toque no texto para rodar ou pausar. Arraste o texto para ajustar a posição.\n\n' +
  'Toque na imagem para focar. Faça pinça para dar zoom.\n\n' +
  'Leia sempre na altura da linha vermelha, perto da câmera.';

const RESOLUTIONS = [
  ['4k', '4K', CommonResolutions.UHD_16_9],
  ['1080p', '1080p', CommonResolutions.FHD_16_9],
  ['720p', '720p', CommonResolutions.HD_16_9],
];
const FPS_OPTIONS = [24, 25, 30, 60];
const CODEC_LABELS = {
  h265: 'HEVC', h264: 'H.264', 'pro-res-422': 'ProRes 422', 'pro-res-422-hq': 'ProRes HQ', 'pro-res-422-lt': 'ProRes LT',
};
const STABS = [['auto', 'Auto'], ['standard', 'Padrão'], ['cinematic', 'Cinemática'], ['cinematic-extended', 'Cinemática+'], ['off', 'Desligada']];
const BITRATE = { '4k': 80_000_000, '1080p': 30_000_000, '720p': 15_000_000 };
const SETTINGS_KEY = 'tp_settings_v2';
const HOST_KEY = 'tp_host';

// ---------- rede ----------
function guessHost() {
  const h = Constants.expoConfig?.hostUri || '';
  const ip = h.split(':')[0];
  return /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : '';
}

async function call(host, path, body, timeout = 1500) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(`http://${host}:${PORT}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// procura o PC na mesma faixa de IP do iPhone (ex.: 192.168.15.1 a .254)
async function findPC() {
  let ip = '';
  try { ip = await Network.getIpAddressAsync(); } catch (e) {}
  const m = /^(\d+\.\d+\.\d+)\.\d+$/.exec(ip || '');
  if (!m) return '';
  const base = m[1];
  const hosts = Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`).filter((h) => h !== ip);
  for (let i = 0; i < hosts.length; i += 48) {
    const batch = hosts.slice(i, i + 48);
    const found = await Promise.any(
      batch.map((h) => call(h, '/state', null, 900).then((s) => (s && typeof s.rev === 'number' ? h : Promise.reject())))
    ).catch(() => '');
    if (found) return found;
  }
  return '';
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Prompter />
    </SafeAreaProvider>
  );
}

function Prompter() {
  useKeepAwake();
  const insets = useSafeAreaInsets();
  const camPerm = useCameraPermission();
  const micPerm = useMicrophonePermission();

  const [text, setText] = useState(DEMO);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);
  const [size, setSize] = useState(32);
  const [recording, setRecording] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [editOpen, setEditOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [host, setHost] = useState(guessHost());
  const [hostDraft, setHostDraft] = useState('');
  const [searching, setSearching] = useState(false);
  const [online, setOnline] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [notice, setNotice] = useState('');

  // ---------- câmera ----------
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [facing, setFacing] = useState('front');
  const [res, setRes] = useState('4k');
  const [fps, setFps] = useState(30);
  const [codec, setCodec] = useState('h265');
  const [highBitrate, setHighBitrate] = useState(true);
  const [hdr, setHdr] = useState(false);
  const [stab, setStab] = useState('auto');
  const [exposure, setExposure] = useState(0);
  const [locked, setLocked] = useState(false);
  const [torch, setTorch] = useState(false);
  const [codecs, setCodecs] = useState([]);
  const [active, setActive] = useState(null); // o que a câmera realmente escolheu

  const device = useCameraDevice(
    facing,
    facing === 'back' ? { physicalDevices: ['ultra-wide-angle', 'wide-angle', 'telephoto'] } : undefined
  );
  const resolution = (RESOLUTIONS.find((r) => r[0] === res) || RESOLUTIONS[0])[2];
  const videoOutput = useVideoOutput({
    targetResolution: resolution,
    enableAudio: !!micPerm.hasPermission,
    targetBitRate: highBitrate ? BITRATE[res] : undefined,
    fileType: 'mov',
    enableHigherResolutionCodecs: true,
  });
  const fpsList = device ? FPS_OPTIONS.filter((f) => safe(() => device.supportsFPS(f), true)) : FPS_OPTIONS;
  const hdrSupported = !!device && safe(() => device.supportedVideoDynamicRanges.some((d) => d.bitDepth === 'hdr-10-bit'), false);
  const stabList = device ? STABS.filter(([v]) => v === 'off' || v === 'auto' || safe(() => device.supportsVideoStabilizationMode(v), false)) : STABS;
  const constraints = [
    { fps },
    { resolutionBias: videoOutput },
    { videoStabilizationMode: stab },
    ...(hdr && hdrSupported ? [{ videoDynamicRange: CommonDynamicRanges.ANY_HDR }] : []),
  ];

  const cam = useRef(null);
  const recorder = useRef(null);

  // ---------- caixa do teleprompter ----------
  const win = useWindowDimensions();
  const defaultBox = () => ({ x: 8, y: insets.top + 4, w: win.width - 16, h: Math.round(win.height * 0.4) });
  const [box, setBox] = useState(defaultBox);
  const [boxAlpha, setBoxAlpha] = useState(0.62);
  const boxRef = useRef(box);
  boxRef.current = box;
  const boxStart = useRef(box);
  const winRef = useRef(win);
  winRef.current = win;

  // ---------- salvar e carregar ajustes ----------
  const loaded = useRef(false);
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(SETTINGS_KEY);
        if (raw) {
          const o = JSON.parse(raw);
          if (o.res) setRes(o.res);
          if (o.fps) setFps(o.fps);
          if (o.codec) setCodec(o.codec);
          if (typeof o.highBitrate === 'boolean') setHighBitrate(o.highBitrate);
          if (typeof o.hdr === 'boolean') setHdr(o.hdr);
          if (o.stab) setStab(o.stab);
          if (o.facing) setFacing(o.facing);
          if (o.box) setBox(o.box);
          if (o.boxAlpha) setBoxAlpha(o.boxAlpha);
          if (o.size) setSize(o.size);
          if (o.speed) setSpeed(o.speed);
          if (typeof o.text === 'string' && o.text) setText(o.text);
        }
        const h = await AsyncStorage.getItem(HOST_KEY);
        if (h && !guessHost()) setHost(h);
      } catch (e) {}
      loaded.current = true;
    })();
  }, []);
  useEffect(() => {
    if (!loaded.current) return;
    const t = setTimeout(() => {
      AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify({ res, fps, codec, highBitrate, hdr, stab, facing, box, boxAlpha, size, speed, text })).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [res, fps, codec, highBitrate, hdr, stab, facing, box, boxAlpha, size, speed, text]);
  useEffect(() => { if (host) AsyncStorage.setItem(HOST_KEY, host).catch(() => {}); }, [host]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  // ---------- rolagem do texto ----------
  const ty = useRef(new Animated.Value(0)).current;
  const pos = useRef(0);
  const boxH = useRef(0);
  const textH = useRef(0);
  const dragging = useRef(false);
  const live = useRef({ playing, speed, size });
  live.current = { playing, speed, size };
  const sync = useRef({ rev: -1, cmd: -1 });
  const recStart = useRef(0);
  const recordingRef = useRef(false);
  recordingRef.current = recording;
  const dragStart = useRef(0);
  const lines = useRef([]);
  const follow = useRef({ on: false, word: 0 });
  const [following, setFollowing] = useState(false);

  const maxPos = () => Math.max(0, textH.current - 40 - live.current.size * 1.3);
  const paint = () => ty.setValue(-pos.current);
  const yForWord = (c) => {
    const L = lines.current;
    if (!L.length) return 0;
    let i = 0;
    while (i + 1 < L.length && L[i + 1].start <= c) i++;
    return L[i].y - L[0].y;
  };

  useEffect(() => {
    let raf, last = 0;
    const loop = (t) => {
      const dt = last ? Math.min(0.1, (t - last) / 1000) : 0;
      last = t;
      const L = live.current;
      if (follow.current.on && !dragging.current) {
        const target = Math.min(maxPos(), yForWord(follow.current.word));
        pos.current += (target - pos.current) * Math.min(1, dt * 8);
        paint();
      } else if (L.playing && !dragging.current) {
        pos.current += dt * L.speed * L.size * 0.32;
        if (pos.current >= maxPos()) {
          pos.current = maxPos();
          setPlaying(false);
        }
        paint();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const jump = useCallback((c) => {
    if (c === 'top') { pos.current = 0; setPlaying(false); }
    if (c === 'back') pos.current = Math.max(0, pos.current - boxH.current * 0.5);
    if (c === 'fwd') pos.current = Math.min(maxPos(), pos.current + boxH.current * 0.5);
    paint();
  }, []);

  // ---------- câmera: codec, exposição, foco ----------
  const onConfigured = useCallback(() => {
    try {
      const list = videoOutput.getSupportedVideoCodecs().filter((c) => CODEC_LABELS[c]);
      setCodecs(list);
      const use = list.includes(codec) ? codec : list.includes('h265') ? 'h265' : list[0];
      if (use) videoOutput.setOutputSettings({ codec: use }).catch(() => {});
    } catch (e) {}
  }, [videoOutput, codec]);
  useEffect(() => { onConfigured(); }, [codec]);

  const lockAEAF = async (on) => {
    const c = cam.current?.controller;
    if (!c) return;
    try {
      if (on) {
        if (device?.supportsFocusLocking) await c.lockCurrentFocus();
        if (device?.supportsExposureLocking) await c.lockCurrentExposure();
        if (device?.supportsWhiteBalanceLocking) await c.lockCurrentWhiteBalance();
      } else {
        await c.resetFocus();
      }
      setLocked(on);
    } catch (e) {
      setNotice('Não deu para travar nesta câmera.');
    }
  };
  const minEv = device?.minExposureBias ?? -2;
  const maxEv = device?.maxExposureBias ?? 2;
  const changeEv = (d) => setExposure((e) => Math.max(minEv, Math.min(maxEv, Math.round((e + d) * 10) / 10)));

  const setLensZoom = async (kind) => {
    const c = cam.current?.controller;
    if (!c || !device) return;
    const f = device.zoomLensSwitchFactors || [];
    const hasUW = (device.physicalDevices || []).some((p) => p.type === 'ultra-wide-angle');
    let z = device.minZoom;
    if (kind === 'wide') z = hasUW && f.length ? f[0] : device.minZoom;
    if (kind === 'tele') z = f.length ? f[f.length - 1] : device.minZoom * 2;
    try { await c.setZoom(Math.max(device.minZoom, Math.min(device.maxZoom, z))); } catch (e) {}
  };

  // ---------- gravação ----------
  const startRecording = useCallback(async () => {
    if (recordingRef.current || countdown) return;
    if (!micPerm.hasPermission) {
      const ok = await micPerm.requestPermission();
      if (!ok) setNotice('Sem microfone: o vídeo vai sair sem som.');
    }
    for (let n = 3; n > 0; n--) {
      setCountdown(n);
      await new Promise((r) => setTimeout(r, 800));
    }
    setCountdown(0);
    try {
      const r = await videoOutput.createRecorder({});
      recorder.current = r;
      await r.startRecording(
        async (filePath) => {
          setRecording(false);
          setPlaying(false);
          recorder.current = null;
          try {
            const uri = filePath.startsWith('file://') ? filePath : `file://${filePath}`;
            if (await Sharing.isAvailableAsync()) {
              await Sharing.shareAsync(uri, { mimeType: 'video/quicktime', UTI: 'com.apple.quicktime-movie', dialogTitle: 'Salvar vídeo' });
            }
          } catch (e) {}
        },
        (err) => {
          setRecording(false);
          setPlaying(false);
          recorder.current = null;
          setNotice('A gravação falhou. Tente HEVC ou outra resolução em ⚙.');
        }
      );
      setRecording(true);
      recStart.current = Date.now();
      setPlaying(true);
    } catch (e) {
      setNotice('Não deu para gravar com essas opções. Tente HEVC ou 1080p em ⚙.');
    }
  }, [countdown, micPerm, videoOutput]);

  const stopRecording = useCallback(() => {
    recorder.current?.stopRecording().catch(() => {});
  }, []);
  const toggleRecording = useCallback(() => {
    recordingRef.current ? stopRecording() : startRecording();
  }, [startRecording, stopRecording]);
  const recRef = useRef(toggleRecording);
  recRef.current = toggleRecording;

  useEffect(() => {
    if (!recording) { setElapsed(0); return; }
    const iv = setInterval(() => setElapsed(Math.floor((Date.now() - recStart.current) / 1000)), 500);
    return () => clearInterval(iv);
  }, [recording]);

  // ---------- sincronia com o PC ----------
  const push = useCallback((patch) => {
    if (!host) return;
    call(host, '/state', { ...patch, from: 'phone' })
      .then((s) => { if (s && typeof s.rev === 'number') sync.current.rev = s.rev; })
      .catch(() => {});
  }, [host]);

  const search = useCallback(async () => {
    setSearching(true);
    const h = await findPC();
    setSearching(false);
    if (h) { setHost(h); setHostDraft(h); setNotice(`PC encontrado em ${h}.`); }
    else setNotice('Não achei o PC. Confira se o INICIAR.bat está aberto e se estão no mesmo Wi-Fi.');
  }, []);

  // na primeira abertura, procura o PC sozinho
  const triedSearch = useRef(false);
  useEffect(() => {
    const t = setTimeout(() => {
      if (!triedSearch.current && !online) { triedSearch.current = true; if (!host) search(); }
    }, 1500);
    return () => clearTimeout(t);
  }, [online, host, search]);

  useEffect(() => {
    if (!host) { setOnline(false); return; }
    let alive = true, fails = 0;
    sync.current = { rev: -1, cmd: -1 };
    const tick = async () => {
      try {
        const m = maxPos();
        const s = await call(host, '/phone', { rev: sync.current.rev, progress: m ? pos.current / m : 0, recording: recordingRef.current });
        if (!alive || !s) return;
        fails = 0;
        setOnline(true);
        if (s.rev > sync.current.rev) {
          sync.current.rev = s.rev;
          if (typeof s.text === 'string' && s.text.trim()) setText(s.text);
          if (typeof s.playing === 'boolean') setPlaying(s.playing);
          if (s.speed >= 1 && s.speed <= 12) setSpeed(s.speed);
          if (s.size >= 18 && s.size <= 80) setSize(s.size);
        }
        const f = s.follow || {};
        if (!!f.on !== follow.current.on) setFollowing(!!f.on);
        follow.current = { on: !!f.on, word: f.word || 0 };
        if (sync.current.cmd === -1) sync.current.cmd = s.cmdSeq;
        else if (s.cmdSeq > sync.current.cmd) {
          sync.current.cmd = s.cmdSeq;
          if (s.cmd === 'rec') recRef.current();
          else jump(s.cmd);
        }
      } catch (e) {
        if (!alive) return;
        setOnline(false);
        // o IP do PC pode ter mudado: procura de novo depois de várias falhas
        if (++fails === 15 && !recordingRef.current) {
          const h = await findPC();
          if (alive && h && h !== host) setHost(h);
        }
      }
    };
    let timer;
    const run = async () => {
      await tick();
      if (alive) timer = setTimeout(run, follow.current.on ? 100 : 400);
    };
    run();
    return () => { alive = false; clearTimeout(timer); };
  }, [host, jump]);

  // ---------- gestos ----------
  const togglePlay = () => {
    const next = !live.current.playing;
    setPlaying(next);
    push({ playing: next });
  };
  const togglePlayRef = useRef(togglePlay);
  togglePlayRef.current = togglePlay;

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => { dragging.current = true; dragStart.current = pos.current; },
      onPanResponderMove: (_, g) => {
        pos.current = Math.max(0, Math.min(maxPos(), dragStart.current - g.dy));
        paint();
      },
      onPanResponderRelease: (_, g) => {
        dragging.current = false;
        if (Math.abs(g.dy) < 6 && Math.abs(g.dx) < 6) togglePlayRef.current();
      },
      onPanResponderTerminate: () => { dragging.current = false; },
    })
  ).current;

  const clampBox = (b) => {
    const W = winRef.current.width, H = winRef.current.height;
    const w = Math.max(160, Math.min(W, b.w));
    const h = Math.max(120, Math.min(H, b.h));
    return { w, h, x: Math.max(0, Math.min(W - w, b.x)), y: Math.max(0, Math.min(H - 60, b.y)) };
  };
  const movePan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => { boxStart.current = boxRef.current; },
      onPanResponderMove: (_, g) => {
        const b = boxStart.current;
        setBox(clampBox({ ...b, x: b.x + g.dx, y: b.y + g.dy }));
      },
    })
  ).current;
  const sizePan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => { boxStart.current = boxRef.current; },
      onPanResponderMove: (_, g) => {
        const b = boxStart.current;
        setBox(clampBox({ ...b, w: b.w + g.dx, h: b.h + g.dy }));
      },
    })
  ).current;

  const changeSpeed = (d) => {
    const v = Math.min(12, Math.max(1, speed + d));
    setSpeed(v);
    push({ speed: v });
  };
  const changeSize = (d) => {
    const v = Math.min(80, Math.max(18, size + d));
    setSize(v);
    push({ size: v });
  };

  // ---------- telas ----------
  if (!camPerm.hasPermission) {
    return (
      <View style={[s.fill, s.center, { padding: 32 }]}>
        <Text style={s.h1}>Teleprompter</Text>
        <Text style={s.p}>Preciso da câmera e do microfone para gravar com o texto na tela.</Text>
        <Btn
          label="Permitir câmera e microfone"
          primary
          onPress={async () => { await camPerm.requestPermission(); await micPerm.requestPermission(); }}
        />
        {!camPerm.canRequestPermission && (
          <Text style={[s.note, { marginTop: 16, textAlign: 'center' }]}>
            Se nada acontecer, libere em Ajustes do iPhone → Teleprompter → Câmera.
          </Text>
        )}
      </View>
    );
  }

  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  const busy = recording || countdown > 0;

  return (
    <View style={s.fill}>
      <StatusBar hidden />
      {device ? (
        <Camera
          ref={cam}
          style={StyleSheet.absoluteFill}
          device={device}
          isActive
          outputs={[videoOutput]}
          constraints={constraints}
          exposure={exposure}
          torchMode={torch && device.hasTorch ? 'on' : 'off'}
          enableNativeZoomGesture
          enableNativeTapToFocusGesture
          onConfigured={onConfigured}
          onSessionConfigSelected={(c) => {
            try {
              setActive({ fps: c.selectedFPS, stab: c.selectedVideoStabilizationMode, hdr: c.selectedVideoDynamicRange?.bitDepth === 'hdr-10-bit' });
            } catch (e) {}
          }}
          onError={(e) => setNotice(`Câmera: ${String(e?.message || e).slice(0, 120)}`)}
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, s.center]}><Text style={s.p}>Abrindo a câmera…</Text></View>
      )}

      {/* caixa do texto */}
      <View style={[s.box, { left: box.x, top: box.y, width: box.w, height: box.h, backgroundColor: `rgba(0,0,0,${boxAlpha})` }]}>
        <View style={s.grip} {...movePan.panHandlers}>
          <View style={s.gripBar} />
        </View>
        <View style={s.scriptArea} onLayout={(e) => { boxH.current = e.nativeEvent.layout.height; }} {...pan.panHandlers}>
          <Animated.View style={{ transform: [{ translateY: ty }] }}>
            <Text
              style={[s.script, { fontSize: size, lineHeight: size * 1.3 }]}
              onLayout={(e) => { textH.current = e.nativeEvent.layout.height; }}
              onTextLayout={(e) => {
                let start = 0;
                lines.current = e.nativeEvent.lines.map((l) => {
                  const r = { start, y: l.y };
                  start += (l.text.match(/\S+/g) || []).length;
                  return r;
                });
              }}
            >
              {text}
            </Text>
          </Animated.View>
          <View style={s.mark} pointerEvents="none" />
        </View>
        <View style={s.resize} {...sizePan.panHandlers}>
          <Text style={s.resizeIcon}>◢</Text>
        </View>
      </View>

      {/* status */}
      <View style={[s.status, { top: insets.top + 8 }]} pointerEvents="box-none">
        {recording && (
          <View style={s.recPill}><View style={s.recDot} /><Text style={s.recTxt}>{mm}:{ss}</Text></View>
        )}
        <Pressable onPress={() => { setHostDraft(host); setLinkOpen(true); }} style={s.linkPill} hitSlop={10}>
          <View style={[s.dot, { backgroundColor: online ? '#2fa84f' : '#777' }]} />
          <Text style={s.linkTxt}>{online ? (following ? 'PC · voz' : 'PC') : searching ? 'procurando…' : 'offline'}</Text>
        </Pressable>
      </View>

      {countdown > 0 && (
        <View style={[StyleSheet.absoluteFill, s.center]} pointerEvents="none">
          <Text style={s.count}>{countdown}</Text>
        </View>
      )}

      {notice ? (
        <View style={s.notice} pointerEvents="none"><Text style={s.noticeTxt}>{notice}</Text></View>
      ) : null}

      {/* controles */}
      <View style={[s.bar, { paddingBottom: insets.bottom + 10 }]}>
        <View style={s.row}>
          <Btn label="−" onPress={() => changeSpeed(-0.5)} />
          <Text style={s.val}>vel {speed}</Text>
          <Btn label="+" onPress={() => changeSpeed(0.5)} />
          <View style={{ width: 8 }} />
          <Btn label="A−" onPress={() => changeSize(-2)} />
          <Btn label="A+" onPress={() => changeSize(2)} />
          <View style={{ width: 8 }} />
          <Btn label="⟲" onPress={() => { if (!busy) { setTorch(false); setLocked(false); setExposure(0); setFacing((f) => (f === 'front' ? 'back' : 'front')); } }} />
        </View>
        <View style={s.row}>
          <Btn label="⏮" onPress={() => { jump('top'); push({ playing: false }); }} />
          <Btn label={playing ? '❚❚' : '▶'} onPress={togglePlay} wide />
          <Pressable onPress={toggleRecording} style={s.recBtn} accessibilityLabel={recording ? 'Parar gravação' : 'Gravar'}>
            <View style={recording ? s.recStop : s.recCircle} />
          </Pressable>
          <Btn label="✎" onPress={() => setEditOpen(true)} />
          <Btn label="⚙" onPress={() => setSettingsOpen(true)} />
        </View>
      </View>

      {/* roteiro */}
      <Modal visible={editOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setEditOpen(false)}>
        <View style={[s.sheet, { paddingTop: 16 }]}>
          <View style={s.sheetHead}>
            <Text style={s.h2}>Roteiro</Text>
            <Btn label="Pronto" primary onPress={() => { setEditOpen(false); push({ text }); }} />
          </View>
          <TextInput
            style={s.editor}
            multiline
            value={text}
            onChangeText={setText}
            placeholder="Cole o roteiro aqui"
            placeholderTextColor="#777"
            textAlignVertical="top"
          />
        </View>
      </Modal>

      {/* ajustes */}
      <Modal visible={settingsOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setSettingsOpen(false)}>
        <ScrollView style={s.sheet} contentContainerStyle={{ paddingTop: 16, paddingBottom: 60, gap: 18 }}>
          <View style={s.sheetHead}>
            <Text style={s.h2}>Câmera</Text>
            <Btn label="Pronto" primary onPress={() => setSettingsOpen(false)} />
          </View>
          {active && (
            <Text style={s.note}>
              Ativo agora: {RESOLUTIONS.find((r) => r[0] === res)?.[1]} · {active.fps ? `${active.fps} fps` : `${fps} fps`}
              {active.hdr ? ' · HDR' : ''}{active.stab && active.stab !== 'off' ? ` · estab. ${active.stab}` : ''}
            </Text>
          )}
          {busy && <Text style={s.p}>Pare a gravação para mudar resolução, FPS e formato.</Text>}

          <Group title="Resolução">
            {RESOLUTIONS.map(([v, l]) => <Chip key={v} label={l} on={res === v} onPress={() => !busy && setRes(v)} />)}
          </Group>
          <Group title="Quadros por segundo" note="Se a combinação não existir nesta câmera, o iPhone usa a mais próxima.">
            {fpsList.map((f) => <Chip key={f} label={`${f} fps`} on={fps === f} onPress={() => !busy && setFps(f)} />)}
          </Group>
          <Group title={`Exposição ${exposure > 0 ? '+' : ''}${exposure.toFixed(1)}`} note="Toque na imagem para focar e medir a luz naquele ponto.">
            <Chip label="− escurecer" onPress={() => changeEv(-0.3)} />
            <Chip label="+ clarear" onPress={() => changeEv(0.3)} />
            <Chip label="Zerar" onPress={() => setExposure(0)} />
          </Group>
          <Group title="Foco, exposição e branco">
            <Chip label="Automático" on={!locked} onPress={() => lockAEAF(false)} />
            <Chip label="Travar como está" on={locked} onPress={() => lockAEAF(true)} />
          </Group>
          {facing === 'back' && (
            <Group title="Lente" note="Pinça com dois dedos na imagem também dá zoom.">
              <Chip label="0.5x" onPress={() => setLensZoom('uw')} />
              <Chip label="1x" onPress={() => setLensZoom('wide')} />
              <Chip label="Tele" onPress={() => setLensZoom('tele')} />
            </Group>
          )}
          {hdrSupported && (
            <Group title="Cor" note="HDR fica mais vivo no iPhone; SDR é mais seguro para postar em qualquer lugar.">
              <Chip label="SDR" on={!hdr} onPress={() => !busy && setHdr(false)} />
              <Chip label="HDR" on={hdr} onPress={() => !busy && setHdr(true)} />
            </Group>
          )}
          <Group title="Formato do vídeo" note="ProRes: qualidade máxima e arquivos enormes (só aparece em iPhone Pro).">
            {(codecs.length ? codecs : ['h265', 'h264']).map((c) => (
              <Chip key={c} label={CODEC_LABELS[c] || c} on={codec === c} onPress={() => !busy && setCodec(c)} />
            ))}
          </Group>
          <Group title="Taxa de bits">
            <Chip label="Alta" on={highBitrate} onPress={() => !busy && setHighBitrate(true)} />
            <Chip label="Padrão" on={!highBitrate} onPress={() => !busy && setHighBitrate(false)} />
          </Group>
          <Group title="Estabilização">
            {stabList.map(([v, l]) => <Chip key={v} label={l} on={stab === v} onPress={() => !busy && setStab(v)} />)}
          </Group>
          {device?.hasTorch && (
            <Group title="Lanterna">
              <Chip label="Ligada" on={torch} onPress={() => setTorch(true)} />
              <Chip label="Desligada" on={!torch} onPress={() => setTorch(false)} />
            </Group>
          )}

          <Text style={[s.h2, { marginTop: 8 }]}>Caixa do texto</Text>
          <Text style={s.p}>Arraste pela barrinha do topo para mover e pelo canto ◢ para mudar o tamanho.</Text>
          <Group title={`Fundo ${Math.round(boxAlpha * 100)}%`}>
            <Chip label="Mais claro" onPress={() => setBoxAlpha((a) => Math.max(0.1, Math.round((a - 0.1) * 10) / 10))} />
            <Chip label="Mais escuro" onPress={() => setBoxAlpha((a) => Math.min(0.95, Math.round((a + 0.1) * 10) / 10))} />
          </Group>
          <Group title="Posição">
            <Chip label="Voltar ao padrão" onPress={() => setBox(defaultBox())} />
          </Group>
        </ScrollView>
      </Modal>

      {/* conexão com o PC */}
      <Modal visible={linkOpen} animationType="fade" transparent onRequestClose={() => setLinkOpen(false)}>
        <View style={[s.fill, s.center, { backgroundColor: 'rgba(0,0,0,.7)', padding: 24 }]}>
          <ScrollView style={s.dialog} contentContainerStyle={{ gap: 12 }} keyboardShouldPersistTaps="handled">
            <Text style={s.h2}>Conexão com o PC</Text>
            <Text style={s.p}>
              {online
                ? `Conectado em ${host}:${PORT}.`
                : 'Sem conexão. Deixe o INICIAR.bat aberto no PC, com os dois no mesmo Wi-Fi, e toque em Procurar.'}
            </Text>
            <Btn label={searching ? 'Procurando…' : 'Procurar o PC'} primary onPress={() => !searching && search()} />
            <Text style={s.label}>Ou digite o IP do PC</Text>
            <TextInput
              style={s.input}
              value={hostDraft}
              onChangeText={setHostDraft}
              placeholder="192.168.0.10"
              placeholderTextColor="#777"
              keyboardType="numbers-and-punctuation"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View style={s.row}>
              <Btn label="Fechar" onPress={() => setLinkOpen(false)} />
              <Btn label="Conectar" onPress={() => { setHost(hostDraft.trim()); setLinkOpen(false); }} />
            </View>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

function safe(fn, fallback) {
  try { return fn(); } catch (e) { return fallback; }
}

function Group({ title, note, children }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={s.label}>{title}</Text>
      <View style={s.chips}>{children}</View>
      {note ? <Text style={s.note}>{note}</Text> : null}
    </View>
  );
}

function Chip({ label, on, onPress }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.chip, on && s.chipOn, pressed && { opacity: 0.6 }]}>
      <Text style={[s.chipTxt, on && { color: '#fff' }]}>{label}</Text>
    </Pressable>
  );
}

function Btn({ label, onPress, primary, wide }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [s.btn, primary && s.btnPrimary, wide && { minWidth: 72 }, pressed && { opacity: 0.6 }]}
      hitSlop={4}
    >
      <Text style={s.btnTxt}>{label}</Text>
    </Pressable>
  );
}

const RED = '#e5251b';
const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center' },
  h1: { color: '#fff', fontSize: 30, fontWeight: '700', marginBottom: 12 },
  h2: { color: '#fff', fontSize: 22, fontWeight: '700' },
  p: { color: '#c8c8cc', fontSize: 16, lineHeight: 22, marginBottom: 8 },
  label: { color: '#a5a5ab', fontSize: 14 },
  note: { color: '#8d8d92', fontSize: 13, lineHeight: 18 },
  box: { position: 'absolute', overflow: 'hidden', borderRadius: 16 },
  grip: { height: 26, alignItems: 'center', justifyContent: 'center' },
  gripBar: { width: 44, height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.55)' },
  scriptArea: { flex: 1, overflow: 'hidden', paddingHorizontal: 16 },
  script: { color: '#fff', fontWeight: '700', paddingTop: 40 },
  mark: { position: 'absolute', left: 0, right: 0, top: 40, height: 2, backgroundColor: 'rgba(229,37,27,0.8)' },
  resize: { position: 'absolute', right: 0, bottom: 0, width: 40, height: 40, alignItems: 'flex-end', justifyContent: 'flex-end', padding: 6 },
  resizeIcon: { color: 'rgba(255,255,255,0.7)', fontSize: 18 },
  status: { position: 'absolute', right: 16, flexDirection: 'row', gap: 8 },
  linkPill: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(0,0,0,.6)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 20 },
  linkTxt: { color: '#ddd', fontSize: 12, fontWeight: '600' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  recPill: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: RED, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 20 },
  recDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff' },
  recTxt: { color: '#fff', fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
  count: { color: RED, fontSize: 160, fontWeight: '800' },
  notice: { position: 'absolute', left: 16, right: 16, bottom: 190, backgroundColor: 'rgba(20,20,22,.92)', borderRadius: 12, padding: 12 },
  noticeTxt: { color: '#fff', fontSize: 14, textAlign: 'center' },
  bar: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingTop: 10, paddingHorizontal: 10, backgroundColor: 'rgba(10,10,12,0.78)', gap: 10 },
  row: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8 },
  val: { color: '#fff', fontSize: 14, minWidth: 52, textAlign: 'center', fontVariant: ['tabular-nums'] },
  btn: { minWidth: 46, height: 44, paddingHorizontal: 12, borderRadius: 10, backgroundColor: '#2a2a2e', alignItems: 'center', justifyContent: 'center' },
  btnPrimary: { backgroundColor: RED },
  btnTxt: { color: '#fff', fontSize: 18, fontWeight: '600' },
  recBtn: { width: 72, height: 72, borderRadius: 36, borderWidth: 4, borderColor: '#fff', alignItems: 'center', justifyContent: 'center', marginHorizontal: 6 },
  recCircle: { width: 54, height: 54, borderRadius: 27, backgroundColor: RED },
  recStop: { width: 28, height: 28, borderRadius: 6, backgroundColor: RED },
  sheet: { flex: 1, backgroundColor: '#111113', paddingHorizontal: 16 },
  sheetHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  editor: { flex: 1, color: '#fff', fontSize: 18, lineHeight: 26, backgroundColor: '#1c1c1f', borderRadius: 12, padding: 14, marginBottom: 40 },
  dialog: { flexGrow: 0, width: '100%', maxWidth: 420, backgroundColor: '#18181a', borderRadius: 16, padding: 20 },
  input: { color: '#fff', fontSize: 18, backgroundColor: '#25252a', borderRadius: 10, paddingHorizontal: 14, height: 48 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: 40, paddingHorizontal: 14, borderRadius: 20, backgroundColor: '#25252a', alignItems: 'center', justifyContent: 'center' },
  chipOn: { backgroundColor: RED },
  chipTxt: { color: '#c8c8cc', fontSize: 15, fontWeight: '600' },
});
