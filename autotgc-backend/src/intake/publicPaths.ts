/**
 * Public (platform-called) webhook paths for the omni-channel intake. Kept in a
 * dependency-free module so the auth middleware can import it without creating a
 * cycle with the route registrar.
 */
export const INTAKE_PUBLIC_PATHS: readonly string[] = [
  '/api/intake/webhook/facebook',
  '/api/intake/webhook/zalo',
];
