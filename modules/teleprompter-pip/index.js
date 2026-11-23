import { requireOptionalNativeModule } from 'expo-modules-core';

// null quando o app roda sem o módulo nativo (ex.: Expo Go)
const Native = requireOptionalNativeModule('TeleprompterPip');

export const isAvailable = !!Native;

export function isSupported() {
  try { return !!Native && Native.isSupported(); } catch (e) { return false; }
}

export function update(opts) {
  if (Native) try { Native.update(opts); } catch (e) {}
}

export async function start() {
  if (!Native) return false;
  return Native.start();
}

export async function stop() {
  if (Native) await Native.stop();
}

export function addListener(event, fn) {
  if (!Native || !Native.addListener) return { remove() {} };
  return Native.addListener(event, fn);
}
