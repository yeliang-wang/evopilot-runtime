/** Runtime-owned compatibility migrated from EvoPilot 0.8.3. See provenance/project-compatibility.json. */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalPath, fail, readRegular } from './files.js';

// Check local navigation without opening links or interpreting code examples.
export function checkProjectNavigation(projectRoot: string): void {
  const markdown = readRegular(path.join(projectRoot, 'README.md'), 2 * 1048576, true)
    .toString().replace(/<!--[\s\S]*?-->/g, '');
  let fence: string | null = null;
  for (const line of markdown.split('\n')) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence || /^(?: {4}|\t)/.test(line)) continue;
    const prose = line.replace(/(`+)[^`]*\1/g, '');
    const destinations = [
      ...prose.matchAll(/\]\(\s*(?:<([^>\n]+)>|([^\s<>)]*))/g),
      ...prose.matchAll(/^\s{0,3}\[[^\]]+\]:\s*(?:<([^>\n]+)>|([^\s<>]+))/g),
    ];
    for (const match of destinations) {
      const href = match[1] ?? match[2];
      if (!href || /^(?:https?:|mailto:|#)/i.test(href)) continue;
      const encoded = href.split(/[?#]/)[0];
      if (!encoded) continue;
      try {
        const relative = decodeURIComponent(encoded);
        if (/^[a-z][a-z0-9+.-]*:/i.test(relative) || path.isAbsolute(relative) || relative.includes('\0')) throw Error('Nonlocal path');
        const target = path.resolve(projectRoot, relative), within = path.relative(projectRoot, target);
        if (within === '..' || within.startsWith('..' + path.sep) || path.isAbsolute(within)) throw Error('Outside project');
        canonicalPath(target);
        const stat = fs.lstatSync(target);
        if (!stat.isFile() && !stat.isDirectory()) throw Error('Not a navigation target');
      } catch {
        fail('PROJECT_NAVIGATION', 'README local link is missing, unsafe or outside the candidate: ' + href);
      }
    }
  }
}
