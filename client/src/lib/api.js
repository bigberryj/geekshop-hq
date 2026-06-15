import axios from 'axios';

export const api = axios.create({ baseURL: '/api' });

export async function fetchJson(url) {
  const { data } = await api.get(url);
  return data;
}

export async function postJson(url, body) {
  const { data } = await api.post(url, body);
  return data;
}

export async function putJson(url, body) {
  const { data } = await api.put(url, body);
  return data;
}

export async function patchJson(url, body) {
  const { data } = await api.patch(url, body);
  return data;
}

export async function delJson(url) {
  const { data } = await api.delete(url);
  return data;
}

export function formatMoney(cents) {
  if (cents == null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

export function formatDuration(seconds) {
  if (!seconds) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
