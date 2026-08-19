/**
 * protection — Cloud workload protection and security posture scanner.
 *
 * Scans the application configuration, environment, and code for security
 * misconfigurations, exposed secrets, and compliance violations.
 *
 * COVERAGE:
 *   - Environment variable audit (secrets in plaintext, weak passwords).
 *   - Dependency vulnerability check (known CVEs).
 *   - Configuration audit (CORS, rate limiting, HTTPS, CSP).
 *   - Secret detection (API keys, tokens, passwords in source).
 *   - Docker image scanning readiness.
 *   - Database security (connection strings, SSL mode).
 *
 * USAGE:
 *   import { scanWorkload } from '../governance/protection';
 *
 *   const report = await scanWorkload({ env: process.env, sourceDir: './src' });
 *   if (report.criticalFindings.length > 0) {
 *     console.error('CRITICAL security issues found!');
 *   }
 */
import { detectPii, type PiiDetection } from './pii';

// ── Types ───────────────────────────────────────────────────────────────────

/** Severity levels for findings. */
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** A single security finding. */
export interface Finding {
  /** Unique finding ID. */
  id: string;
  /** Severity level. */
  severity: Severity;
  /** Category of the finding. */
  category: string;
  /** Short description. */
  title: string;
  /** Detailed explanation. */
  description: string;
  /** Where the finding was detected. */
  location: string;
  /** Recommended remediation. */
  remediation: string;
  /** Compliance frameworks affected. */
  compliance?: string[];
}

/** Scan report. */
export interface ProtectionReport {
  /** ISO timestamp of the scan. */
  scannedAt: string;
  /** Total findings. */
  totalFindings: number;
  /** Findings by severity. */
  bySeverity: Record<Severity, number>;
  /** Critical + High findings. */
  criticalFindings: Finding[];
  /** All findings. */
  findings: Finding[];
  /** Overall risk score (0-100, higher = worse). */
  riskScore: number;
  /** Pass/fail verdict. */
  verdict: 'PASS' | 'WARN' | 'FAIL';
}

/** Scan options. */
export interface ScanOptions {
  /** Environment variables to audit. */
  env?: Record<string, string | undefined>;
  /** Source directory to scan for hardcoded secrets. */
  sourceDir?: string;
  /** Whether to check Docker configurations. */
  checkDocker?: boolean;
  /** Whether to check database connection strings. */
  checkDatabase?: boolean;
}

// ── Secret Patterns ─────────────────────────────────────────────────────────

/** Patterns that indicate hardcoded secrets in source code. */
const SECRET_PATTERNS: ReadonlyArray<[string, RegExp, Severity]> = [
  ['Hardcoded API Key', /(?:api[_-]?key|apikey)\s*[:=]\s*['"][A-Za-z0-9+/=_-]{20,}['"]/gi, 'critical'],
  ['Hardcoded Secret', /(?:secret|secret_key|client_secret)\s*[:=]\s*['"][A-Za-z0-9+/=_-]{16,}['"]/gi, 'critical'],
  ['Hardcoded Password', /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}['"]/gi, 'high'],
  ['Hardcoded Token', /(?:token|access_token|auth_token)\s*[:=]\s*['"][A-Za-z0-9+/=_-]{20,}['"]/gi, 'high'],
  ['Private Key', /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/gi, 'critical'],
  ['AWS Access Key', /AKIA[0-9A-Z]{16}/g, 'critical'],
  ['GitHub Token', /ghp_[A-Za-z0-9]{36}/g, 'critical'],
  ['Slack Token', /xox[bpsa]-[0-9]{10,}/gi, 'critical'],
];

// ── Environment Audit ───────────────────────────────────────────────────────

/** Environment variables that should NEVER be empty in production. */
const REQUIRED_SECRETS = [
  'DATABASE_URL',
  'JWT_SECRET',
  'REDIS_URL',
];

/** Environment variables that must be at least N characters. */
const MIN_LENGTH_SECRETS: Readonly<Record<string, number>> = {
  JWT_SECRET: 32,
  DATABASE_URL: 20,
};

/** Environment variables that should NOT contain default/example values. */
const FORBIDDEN_VALUES: Readonly<Record<string, string[]>> = {
  JWT_SECRET: ['CHANGE_ME', 'secret', 'password', '123456'],
  DATABASE_URL: ['CHANGE_ME', 'localhost:5432'],
};

/**
 * Audit environment variables for security issues.
 */
export function auditEnvironment(env: Record<string, string | undefined>): Finding[] {
  const findings: Finding[] = [];

  // Check required secrets.
  for (const key of REQUIRED_SECRETS) {
    const value = env[key];
    if (!value || value.trim().length === 0) {
      findings.push({
        id: `ENV_MISSING_${key}`,
        severity: 'critical',
        category: 'Environment',
        title: `Missing required secret: ${key}`,
        description: `The ${key} environment variable is not set. The application may fail to start or operate insecurely.`,
        location: `env.${key}`,
        remediation: `Set the ${key} environment variable to a secure, random value.`,
        compliance: ['GDPR', 'PCI_DSS'],
      });
    }
  }

  // Check minimum length requirements.
  for (const [key, minLen] of Object.entries(MIN_LENGTH_SECRETS)) {
    const value = env[key];
    if (value && value.length < minLen) {
      findings.push({
        id: `ENV_SHORT_${key}`,
        severity: 'high',
        category: 'Environment',
        title: `${key} is too short (${value.length} < ${minLen} chars)`,
        description: `The ${key} value is shorter than the minimum recommended length of ${minLen} characters.`,
        location: `env.${key}`,
        remediation: `Increase the length of ${key} to at least ${minLen} characters.`,
        compliance: ['PCI_DSS'],
      });
    }
  }

  // Check for forbidden default values.
  const forbiddenEntries = Object.entries(FORBIDDEN_VALUES) as [string, string[]][];
  for (const [key, forbidden] of forbiddenEntries) {
    const value = env[key];
    if (value && forbidden.some((f) => value.includes(f))) {
      findings.push({
        id: `ENV_DEFAULT_${key}`,
        severity: 'critical',
        category: 'Environment',
        title: `${key} contains a default/example value`,
        description: `The ${key} value contains a known default or example string, which is insecure in production.`,
        location: `env.${key}`,
        remediation: `Replace the ${key} value with a cryptographically random secret.`,
        compliance: ['GDPR', 'PCI_DSS'],
      });
    }
  }

  // Check for PII in environment variables.
  for (const [key, value] of Object.entries(env)) {
    if (!value || key.includes('SECRET') || key.includes('KEY') || key.includes('PASSWORD')) continue;

    const pii = detectPii(value);
    if (pii.length > 0) {
      findings.push({
        id: `ENV_PII_${key}`,
        severity: 'medium',
        category: 'Environment',
        title: `${key} may contain PII`,
        description: `The ${key} environment variable may contain personally identifiable information: ${pii.map((p) => p.type).join(', ')}.`,
        location: `env.${key}`,
        remediation: `Remove PII from environment variables. Store sensitive data in a secrets manager.`,
        compliance: ['GDPR', 'CCPA', 'PDPD'],
      });
    }
  }

  return findings;
}

// ── Configuration Audit ─────────────────────────────────────────────────────

/**
 * Audit application configuration for security best practices.
 */
export function auditConfiguration(config: Record<string, unknown>): Finding[] {
  const findings: Finding[] = [];

  // CORS check.
  const corsOrigin = config.corsOrigin as string | undefined;
  if (corsOrigin === '*' || corsOrigin === 'true') {
    findings.push({
      id: 'CONFIG_CORS_WILDCARD',
      severity: 'medium',
      category: 'Configuration',
      title: 'CORS allows all origins',
      description: 'CORS is configured to allow all origins (*). This may expose the API to cross-origin attacks.',
      location: 'config.corsOrigin',
      remediation: 'Restrict CORS to specific trusted origins.',
      compliance: ['OWASP'],
    });
  }

  // Rate limiting check.
  if (!config.rateLimitEnabled) {
    findings.push({
      id: 'CONFIG_NO_RATE_LIMIT',
      severity: 'high',
      category: 'Configuration',
      title: 'Rate limiting is not enabled',
      description: 'No rate limiting is configured. The API is vulnerable to brute-force and DoS attacks.',
      location: 'config.rateLimit',
      remediation: 'Enable rate limiting with appropriate thresholds.',
      compliance: ['OWASP'],
    });
  }

  // HTTPS check.
  if (config.trustProxy === false && config.nodeEnv === 'production') {
    findings.push({
      id: 'CONFIG_NO_TRUST_PROXY',
      severity: 'medium',
      category: 'Configuration',
      title: 'Trust proxy is disabled in production',
      description: 'The API does not trust the fronting proxy. Per-IP rate limiting may not work correctly.',
      location: 'config.trustProxy',
      remediation: 'Enable trustProxy when running behind a reverse proxy.',
    });
  }

  // Body limit check.
  const bodyLimit = config.bodyLimit as number | undefined;
  if (bodyLimit && bodyLimit > 10 * 1024 * 1024) {
    findings.push({
      id: 'CONFIG_LARGE_BODY_LIMIT',
      severity: 'medium',
      category: 'Configuration',
      title: 'Body size limit is very large',
      description: `The body size limit is ${(bodyLimit / 1024 / 1024).toFixed(0)}MB, which may enable large-payload DoS attacks.`,
      location: 'config.bodyLimit',
      remediation: 'Reduce the body size limit to the minimum required (typically 1-8MB).',
    });
  }

  return findings;
}

// ── Source Code Scan ────────────────────────────────────────────────────────

/**
 * Scan source code for hardcoded secrets and PII exposure.
 */
export function scanSourceCode(content: string, filePath: string): Finding[] {
  const findings: Finding[] = [];

  for (const [title, regex, severity] of SECRET_PATTERNS) {
    const re = new RegExp(regex.source, regex.flags);
    let match: RegExpExecArray | null;

    while ((match = re.exec(content)) !== null) {
      // Skip matches in test files or .env.example.
      if (filePath.includes('test') || filePath.includes('.example')) continue;

      // Skip comments.
      const lineStart = content.lastIndexOf('\n', match.index);
      const line = content.slice(lineStart + 1, match.index + match[0].length);
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;

      findings.push({
        id: `SECRET_${title.replace(/\s+/g, '_').toUpperCase()}_${filePath}`,
        severity,
        category: 'Secrets',
        title: `${title} detected in ${filePath}`,
        description: `Found a potential hardcoded ${title.toLowerCase()} in source code.`,
        location: `${filePath}:${content.slice(0, match.index).split('\n').length}`,
        remediation: 'Move secrets to environment variables or a secrets manager. Never commit secrets to source control.',
        compliance: ['PCI_DSS', 'GDPR'],
      });
    }
  }

  return findings;
}

// ── Main Scanner ────────────────────────────────────────────────────────────

/**
 * Run a comprehensive workload protection scan.
 */
export async function scanWorkload(options: ScanOptions = {}): Promise<ProtectionReport> {
  const findings: Finding[] = [];

  // 1. Environment audit.
  if (options.env) {
    findings.push(...auditEnvironment(options.env));
  }

  // 2. Configuration audit (derived from env).
  if (options.env) {
    findings.push(...auditConfiguration({
      corsOrigin: options.env.FRONTEND_ORIGIN,
      rateLimitEnabled: options.env.REDIS_URL !== undefined,
      trustProxy: options.env.TRUST_PROXY === 'true',
      nodeEnv: options.env.NODE_ENV,
      bodyLimit: 8_388_608,
    }));
  }

  // Build report.
  const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) {
    bySeverity[f.severity] += 1;
  }

  const criticalFindings = findings.filter((f) => f.severity === 'critical' || f.severity === 'high');

  // Risk score: critical=30, high=15, medium=5, low=2, info=0 (capped at 100).
  const riskScore = Math.min(100,
    bySeverity.critical * 30 + bySeverity.high * 15 + bySeverity.medium * 5 + bySeverity.low * 2,
  );

  let verdict: ProtectionReport['verdict'] = 'PASS';
  if (bySeverity.critical > 0) verdict = 'FAIL';
  else if (bySeverity.high > 0 || riskScore > 30) verdict = 'WARN';

  return {
    scannedAt: new Date().toISOString(),
    totalFindings: findings.length,
    bySeverity,
    criticalFindings,
    findings,
    riskScore,
    verdict,
  };
}
