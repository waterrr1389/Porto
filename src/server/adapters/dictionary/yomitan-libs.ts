// Yomitan's modules import third-party code from `ext/lib/`, which only exists
// after its own build. Those imports are redirected to the libraries that
// scripts/build-yomitan-libs.ts writes into vendor-build/, so the submodule
// stays untouched.
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../../../..');
const libUrl = pathToFileURL(resolve(root, 'vendor/yomitan/ext/lib')).href + '/';
const buildDir = resolve(root, 'vendor-build');

let registered = false;

/** Installs the redirect; idempotent. Must run before any Yomitan module is imported. */
export function registerYomitanLibs(): void {
  if (registered) return;
  if (!existsSync(resolve(buildDir, 'zip.js'))) {
    throw new Error('vendor-build/ is missing; run `npm run build:yomitan`');
  }
  registered = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      // The default resolver rejects the missing ext/lib files, so relative
      // specifiers are matched before delegating.
      if (specifier.startsWith('.') && context.parentURL) {
        const url = new URL(specifier, context.parentURL).href;
        if (url.startsWith(libUrl)) {
          const target = resolve(buildDir, url.slice(libUrl.length));
          return { url: pathToFileURL(target).href, format: 'module', shortCircuit: true };
        }
      }
      return nextResolve(specifier, context);
    },
  });
}

/** Absolute path of the Yomitan checkout. */
export const yomitanDir = resolve(root, 'vendor/yomitan');
