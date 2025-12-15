import type { LoaderFunctionArgs, HeadersFunction } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { formatCurrency } from "../utils/currency";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  // Get shop currency
  const shopResponse = await admin.graphql(
    `#graphql
    query getShopCurrency {
      shop {
        currencyCode
        currencyFormats {
          moneyFormat
        }
      }
    }`
  );
  const shopData = await shopResponse.json();
  const currencyCode = shopData.data?.shop?.currencyCode || "USD";

  // Get stats for the dashboard
  const [productCount, giftCardCount, recentOrders] = await Promise.all([
    db.giftCardProduct.count({
      where: { shop: session.shop },
    }),
    db.giftCardRecord.count({
      where: { shop: session.shop },
    }),
db.giftCardRecord.findMany({
      where: { shop: session.shop },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        orderId: true,
        orderName: true,
        createdAt: true,
        value: true,
      },
    }),
  ]);

  // Calculate total value
  const totalValueResult = await db.giftCardRecord.aggregate({
    where: { shop: session.shop },
    _sum: { value: true },
  });

  // Group records by order and calculate totals
  const orderMap = new Map<string, { orderName: string; totalValue: number; createdAt: Date }>();
  for (const record of recentOrders) {
    const existing = orderMap.get(record.orderId);
    if (existing) {
      existing.totalValue += Number(record.value);
    } else {
      orderMap.set(record.orderId, {
        orderName: record.orderName,
        totalValue: Number(record.value),
        createdAt: record.createdAt,
      });
    }
  }

  // Convert to array and take top 5
  const groupedOrders = Array.from(orderMap.entries())
    .map(([orderId, data]) => ({
      orderId,
      ...data,
    }))
    .slice(0, 5);

  return {
    productCount,
    giftCardCount,
    totalValue: totalValueResult._sum.value
      ? Number(totalValueResult._sum.value)
      : 0,
    recentOrders: groupedOrders,
    currencyCode,
  };
};

export default function Index() {
  const { productCount, giftCardCount, totalValue, recentOrders, currencyCode } =
    useLoaderData<typeof loader>();

  const formatDate = (date: Date | string) => {
    return new Date(date).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <s-page heading="Physical Gift Cards">
      <s-button slot="primary-action" href="/app/settings">
        Configure Products
      </s-button>

      <s-section heading="Overview">
        <s-paragraph>
          Automatically create Shopify gift cards when customers purchase
          designated products. Perfect for selling physical gift cards that you
          print and package for customers.
        </s-paragraph>

        <s-stack direction="inline" gap="base">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="small">
              <s-heading>{productCount}</s-heading>
              <s-text>Gift Card Products</s-text>
            </s-stack>
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="small">
              <s-heading>{giftCardCount}</s-heading>
              <s-text>Gift Cards Created</s-text>
            </s-stack>
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="small">
              <s-heading>{formatCurrency(totalValue, currencyCode)}</s-heading>
              <s-text>Total Value</s-text>
            </s-stack>
          </s-box>
        </s-stack>
      </s-section>

      {productCount === 0 ? (
        <s-section heading="Get Started">
          <s-banner tone="info">
            <s-stack direction="block" gap="base">
              <s-text type="strong">No gift card products configured</s-text>
              <s-paragraph>
                To start generating gift cards, you need to select which
                products should trigger gift card creation when purchased.
              </s-paragraph>
              <s-button href="/app/settings">Configure Products</s-button>
            </s-stack>
          </s-banner>
        </s-section>
      ) : recentOrders.length > 0 ? (
        <s-section heading="Recent Gift Card Orders">
          <s-stack direction="block" gap="small">
            {recentOrders.map((order) => (
              <s-link
                key={order.orderId}
                href="/app/orders"
              >
                <s-box
                  padding="small"
                  borderWidth="base"
                  borderRadius="base"
                >
                  <s-stack direction="inline" gap="base" alignItems="center">
                    <s-text type="strong">{order.orderName}</s-text>
                    <s-text>{formatCurrency(order.totalValue, currencyCode)}</s-text>
                    <s-text color="subdued">
                      {formatDate(order.createdAt)}
                    </s-text>
                  </s-stack>
                </s-box>
              </s-link>
            ))}
          </s-stack>
          <s-box paddingBlockStart="base">
            <s-button href="/app/orders" variant="tertiary">
              View all orders
            </s-button>
          </s-box>
        </s-section>
      ) : (
        <s-section heading="Waiting for Orders">
          <s-banner tone="info">
            <s-paragraph>
              You have {productCount} product{productCount !== 1 ? "s" : ""}{" "}
              configured. When customers purchase these products, gift cards
              will be automatically created and appear here.
            </s-paragraph>
          </s-banner>
        </s-section>
      )}

      <s-section slot="aside" heading="How it works">
        <s-unordered-list>
          <s-list-item>
            <s-text type="strong">1. Configure products</s-text>
            <s-paragraph>
              Select which products should generate gift cards when purchased.
            </s-paragraph>
          </s-list-item>
          <s-list-item>
            <s-text type="strong">2. Customer purchases</s-text>
            <s-paragraph>
              When a customer buys a configured product and pays, a gift card is
              automatically created.
            </s-paragraph>
          </s-list-item>
          <s-list-item>
            <s-text type="strong">3. View codes</s-text>
            <s-paragraph>
              View gift card codes in the Orders page. Print and package them as
              physical gift cards.
            </s-paragraph>
          </s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section slot="aside" heading="Quick Links">
        <s-stack direction="block" gap="small">
          <s-link href="/app/orders">View Orders</s-link>
          <s-link href="/app/settings">Settings</s-link>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
