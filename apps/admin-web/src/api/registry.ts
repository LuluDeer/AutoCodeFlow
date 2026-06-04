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
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return Array.from(doc.querySelectorAll('a')).map(a => a.textContent ?? '').filter(Boolean);
  },

  // Get files for a PyPI package
  getPypiPackage: async (name: string): Promise<PypiFile[]> => {
    const resp = await fetch(
      (import.meta.env.VITE_PYPI_URL || 'http://localhost:8003') + `/simple/${name}/`,
    );
    const html = await resp.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return Array.from(doc.querySelectorAll('a')).map(a => {
      const href = a.getAttribute('href') ?? '';
      return {
        url: href.split('#')[0],
        sha256: href.includes('#sha256=') ? href.split('#sha256=')[1] : '',
        filename: a.textContent ?? '',
      };
    }).filter(f => f.filename);
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
