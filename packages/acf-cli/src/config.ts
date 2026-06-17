#!/usr/bin/env node
/**
 * Persistent config store for the ACF CLI.
 * Stores API URL and token in the user's config directory.
 */
import Conf from 'conf';

interface AcfConfig {
  apiUrl: string;
  token: string;
}

const store = new Conf<AcfConfig>({
  projectName: 'acf-cli',
  defaults: {
    apiUrl: 'http://localhost:3105',
    token: '',
  },
});

export function getApiUrl(): string {
  return process.env.ACF_API_URL || store.get('apiUrl');
}

export function getToken(): string {
  return process.env.ACF_TOKEN || store.get('token');
}

export function setApiUrl(url: string): void {
  store.set('apiUrl', url);
}

export function setToken(token: string): void {
  store.set('token', token);
}

export function showConfig(): void {
  console.log('API URL :', getApiUrl());
  console.log('Token   :', getToken() ? '[set]' : '[not set]');
  console.log('Config file:', store.path);
}
