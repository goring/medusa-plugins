import * as crypto from 'crypto';
import OrderService from "@medusajs/medusa/dist/services/order";
import TotalsService from "@medusajs/medusa/dist/services/totals";
import { Cart, Payment } from "@medusajs/medusa/dist";
import { CustomerService, RegionService } from "@medusajs/medusa/dist/services";
import { PaymentService } from "medusa-interfaces";
import { PaymentSessionStatus } from "@medusajs/medusa/dist/models/payment-session";
import { MerchantConfig, PaymentSessionData } from "../types";
import buildAddressFromCart from "../utils/buildAddressFromCart";
import request from "../utils/request";
import CartService from "@medusajs/medusa/dist/services/cart";
import * as nodeBase64 from 'nodejs-base64-converter';
import findPendingPaymentSession from "../utils/findPendingPaymentSession";
import buildPaytrToken from "../utils/buildPaytrToken";

export default class PayTRProviderService extends PaymentService {
    static identifier = "paytr";

    readonly #merchantConfig: MerchantConfig;

    readonly #orderService: OrderService;
    readonly #customerService: CustomerService;
    readonly #regionService: RegionService;
    readonly #totalsService: TotalsService;
    readonly #cartService: CartService;

    constructor({ cartService, customerService, totalsService, regionService, orderService }, options: MerchantConfig) {
        super();

        this.#merchantConfig = options;

        this.#orderService = orderService;
        this.#customerService = customerService;
        this.#regionService = regionService;
        this.#totalsService = totalsService;
        this.#cartService = cartService;
    }

    async generateToken(cartId: string): Promise<string | never> {
        const cart = await this.retrieveCart(cartId);
        const amount = await this.#totalsService.getTotal(cart);
        const { currency_code } = await this.#regionService.retrieve(cart.region_id);
        const formattedItems = cart.items.map(item => [
            item.title,
            (item.unit_price / 100).toFixed(2).toString(),
            item.quantity.toString()
        ]);
        const cartToken = nodeBase64.encode(JSON.stringify(formattedItems));
        const userIp = cart.context?.ip ?? 'xxx.x.xxx.xxx';
        const merchantOid = cart.id.split('_').pop();
        const payTrToken = await buildPaytrToken({
            amount,
            orderId: merchantOid,
            email: cart.customer?.email,
            ip: userIp,
            currency_code,
            cartToken,
            merchantConfig: this.#merchantConfig
        });
        const billingAddress = buildAddressFromCart(cart);
        const { token_endpoint, ...config } = this.#merchantConfig;
        const data = {
            ...config,
            paytr_token: payTrToken,
            no_installment: this.#merchantConfig.no_installment,
            max_installment: this.#merchantConfig.max_installment,
            payment_amount: amount,
            currency: currency_code,
            user_name: (cart?.billing_address?.first_name + ' ' + cart?.billing_address?.last_name).trim(),
            user_address: billingAddress,
            email: cart.customer?.email,
            user_phone: cart.billing_address?.phone,
            user_ip: userIp,
            user_basket: cartToken,
            merchant_oid: merchantOid,
            lang: cart.customer?.metadata?.lang ?? 'tr',
        };

        try {
            return await request(token_endpoint, data);
        } catch (e) {
            throw new Error(`An error occurred while trying to create the payment.\n${e?.message ?? e}`);
        }
    }

    async createPayment(cart: Cart): Promise<PaymentSessionData> {
        const merchantOid = cart.id.split('_').pop();
        return {
            merchantOid,
            isPending: true,
            status: -1
        };
    }

    async getStatus(payment: Payment): Promise<PaymentSessionStatus> {
        const { data: { status } } = payment;

        if (status === -1) {
            return PaymentSessionStatus.PENDING;
        }

        const errorStatusCodes = [0, 1, 2, 3, 6, 9, 11, 99];

        if (errorStatusCodes.includes(status)) {
            return PaymentSessionStatus.ERROR;
        }

        return PaymentSessionStatus.AUTHORIZED;
    }

    async retrievePayment(data: unknown): Promise<unknown> {
        return data;
    }

    async getPaymentData(sessionData: { data: PaymentSessionData }): Promise<PaymentSessionData> {
        return sessionData.data;
    }

    async authorizePayment(): Promise<{ status: string; data: { status: string; } }> {
        return { status: "authorized", data: { status: "authorized" } };
    }

    async updatePayment(sessionData: { data: PaymentSessionData }, updateData: PaymentSessionData): Promise<PaymentSessionData> {
        return {
            ...sessionData.data,
            ...updateData
        };
    }

    async deletePayment(): Promise<void> {
        return;
    }

    async capturePayment() {
        return { status: "captured" }
    }

    async refundPayment(payment: { data: unknown }): Promise<unknown> {
        return payment.data;
    }

    async cancelPayment(): Promise<{ status: string; }> {
        return { status: "canceled" };
    }

    public async handleCallback({ merchant_oid, status, total_amount, hash, cartId }: any): Promise<void | never> {
        const paytrToken = merchant_oid + this.#merchantConfig.merchant_salt + status + total_amount;
        const token = crypto.createHmac('sha256', this.#merchantConfig.merchant_key).update(paytrToken).digest('base64');

        if (token != hash) {
            throw new Error("PAYTR notification failed: bad hash");
        }

        const cart = await this.retrieveCart(cartId);
        const pendingPaymentSession = await findPendingPaymentSession(cart.payment_sessions, { merchantOid: merchant_oid });
        if (!pendingPaymentSession) {
            throw new Error('Unable to complete payment session. The payment session was not found.');
        }
        await this.updatePayment(pendingPaymentSession, {
            status: status == 'success' ? null : 0,
            isPending: false,
            merchantOid: merchant_oid
        });
    }

    private async retrieveCart(cartId: string): Promise<Cart> {
        return this.#cartService.retrieve(cartId, {
            select: [
                "gift_card_total",
                "subtotal",
                "tax_total",
                "shipping_total",
                "discount_total",
                "total",
            ],
            relations: [
                "items",
                "discounts",
                "discounts.rule",
                "discounts.rule.valid_for",
                "gift_cards",
                "billing_address",
                "shipping_address",
                "region",
                "region.payment_providers",
                "payment_sessions",
                "customer",
            ],
        });
    }
}