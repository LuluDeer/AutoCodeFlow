import { client } from './client';

export interface PypiPackage {
  name: string;
  files: PypiFile[];
}

export interface PypiFile {
  filename: string;
  url: string;
  sha256: string;
}

export interface NpmPackage {
  name: string;
  versions: string[];
  description?: string;
  latest?: string;
}

// PyPI registry
export const registryApi = {
  // List all PyPI packages
  listPypiPackages: async (): Promise<string[]> => {
    const resp = await fetch(
      (import.meta.env.VITE_PYPI_URL || 'http://localhost:8003') + '/simple/',
    );
    const html = await resp.text();
    const matches = html.matchAll(/<a href[^>]*>([^<]+)<\/a>/g);
    return Array.from(matches).map(m => m[1]);
  },

  // Get files for a PyPI package
  getPypiPackage: async (name: string): Promise<PypiFile[]> => {
    const resp = await fetch(
      (import.meta.env.VITE_PYPI_URL || 'http://localhost:8003') + `/simple/${name}/`,
    );
    const html = await resp.text();
    const matches = html.matchAll(/<a href="([^"]+)"(?:[^>]*)>([^<]+)<\/a>/g);
    return Array.from(matches).map(m => ({
      url: m[1].split('#')[0],
      sha256: m[1].includes('#sha256=') ? m[1].split('#sha256=')[1] : '',
      filename: m[2],
    }));
  },

  // Upload PyPI package (admin API proxy)
  uploadPypiPackage: async (form: FormData): Promise<void> => {
    await client.post('/registry/pypi/upload', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },

  // List npm packages from Verdaccio
  listNpmPackages: async (): Promise<NpmPackage[]> => {
    try {
      const resp = await fetch(
        (import.meta.env.VITE_NPM_URL || 'http://localhost:4873') + '/-/verdaccio/packages',
      );
      if (!resp.ok) return [];
      return resp.json();
    } catch {
      return [];
    }
  },
};
