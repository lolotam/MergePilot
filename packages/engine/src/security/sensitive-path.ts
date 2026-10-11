export function isSensitivePath(path: string): boolean {
  const normalized = path.replace(/[/\\]+$/, '');
  const basename = normalized.split(/[/\\]/).pop() ?? '';
  const lower = basename.toLowerCase();

  if (lower === '.env.example') {
    return false;
  }

  if (lower === '.env' || lower.startsWith('.env.')) {
    return true;
  }

  if (
    lower.endsWith('.pem') ||
    lower.endsWith('.key') ||
    lower.endsWith('.p12') ||
    lower.endsWith('.pfx')
  ) {
    return true;
  }

  if (lower.startsWith('id_rsa') || lower.startsWith('id_ed25519')) {
    return true;
  }

  if (lower === 'credentials.json' || lower === '.npmrc' || lower === '.pypirc') {
    return true;
  }

  return false;
}
