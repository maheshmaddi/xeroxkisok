import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { ADMIN_COOKIE, readCookie, verifySessionToken } from './admin-auth.util';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const email = this.config.get<string>('ADMIN_EMAIL') ?? 'admin@local';
    const secret = this.config.get<string>('JWT_SECRET') ?? 'dev-jwt-secret-change-me';
    const token = readCookie(req, ADMIN_COOKIE);
    if (!verifySessionToken(token, email, secret)) {
      throw new UnauthorizedException('Admin session required');
    }
    return true;
  }
}
