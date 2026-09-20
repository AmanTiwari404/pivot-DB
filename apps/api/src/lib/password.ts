import bcrypt from 'bcryptjs';
import { z } from 'zod';

const SALT_ROUNDS = 12;

export const PasswordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters');

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
