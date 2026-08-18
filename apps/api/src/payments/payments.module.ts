import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MockPayProvider } from './mock.provider';
import { RazorpayProvider } from './razorpay.provider';
import { PAY_PROVIDER } from './payments.constants';
import { RefundsService } from './refunds.service';
import type { PayProvider } from './payments.types';

@Global()
@Module({
  providers: [
    {
      provide: PAY_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): PayProvider => {
        const keyId = config.get<string>('RAZORPAY_KEY_ID');
        const keySecret = config.get<string>('RAZORPAY_KEY_SECRET');
        // PAYMENTS_MODE: auto (default — Razorpay when keys present), mock, razorpay.
        const mode = config.get<string>('PAYMENTS_MODE') ?? 'auto';
        const useRazorpay = mode === 'razorpay' || (mode === 'auto' && Boolean(keyId && keySecret));

        if (useRazorpay) {
          if (!keyId || !keySecret) {
            throw new Error('PAYMENTS_MODE=razorpay requires RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET');
          }
          const webhookSecret = config.get<string>('RAZORPAY_WEBHOOK_SECRET');
          if (!webhookSecret) {
            throw new Error('RAZORPAY_WEBHOOK_SECRET is required when Razorpay keys are set');
          }
          return new RazorpayProvider(keyId, keySecret, webhookSecret);
        }
        return new MockPayProvider(); // dev / Phase 1 mock-pay flow
      },
    },
    RefundsService,
  ],
  exports: [PAY_PROVIDER, RefundsService],
})
export class PaymentsModule {}
