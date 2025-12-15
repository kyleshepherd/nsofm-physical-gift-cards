import type {
  LoaderFunctionArgs,
  ActionFunctionArgs,
  HeadersFunction,
} from "react-router";
import { useLoaderData, useSearchParams, useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { formatCurrency } from "../utils/currency";

const ORDERS_PER_PAGE = 10;

interface GiftCardInfo {
  id: string;
  giftCardCode: string;
  value: number;
  currentBalance: number;
  giftCardId: string;
  printedAt: string | null;
  createdAt: Date;
}

interface OrderWithGiftCards {
  orderId: string;
  orderName: string;
  customerName: string | null;
  customerEmail: string | null;
  giftCards: GiftCardInfo[];
  totalValue: number;
  createdAt: Date;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));

  // Get shop currency
  const shopResponse = await admin.graphql(
    `#graphql
    query getShopCurrency {
      shop {
        currencyCode
      }
    }`,
  );
  const shopData = await shopResponse.json();
  const currencyCode = shopData.data?.shop?.currencyCode || "USD";

  // Get total count of unique orders
  const allOrderIds = await db.giftCardRecord.findMany({
    where: { shop: session.shop },
    distinct: ["orderId"],
    select: { orderId: true },
  });
  const totalOrders = allOrderIds.length;
  const totalPages = Math.ceil(totalOrders / ORDERS_PER_PAGE);

  // Get gift card records from our database
  const giftCardRecords = await db.giftCardRecord.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
  });

  // Fetch current balances for all gift cards from Shopify
  const giftCardIds = giftCardRecords.map((r) => r.giftCardId);
  const balanceMap = new Map<string, number>();

  // Batch fetch gift card balances (max 100 per query)
  for (let i = 0; i < giftCardIds.length; i += 100) {
    const batch = giftCardIds.slice(i, i + 100);
    try {
      const response = await admin.graphql(
        `#graphql
        query getGiftCardBalances($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on GiftCard {
              id
              balance {
                amount
              }
            }
          }
        }`,
        { variables: { ids: batch } },
      );
      const data = await response.json();
      for (const node of data.data?.nodes || []) {
        if (node?.id && node?.balance) {
          balanceMap.set(node.id, parseFloat(node.balance.amount));
        }
      }
    } catch (error) {
      console.error("Failed to fetch gift card balances:", error);
    }
  }

  // Group by order
  const orderMap = new Map<string, typeof giftCardRecords>();

  for (const record of giftCardRecords) {
    const existing = orderMap.get(record.orderId) || [];
    existing.push(record);
    orderMap.set(record.orderId, existing);
  }

  const allOrders: OrderWithGiftCards[] = Array.from(orderMap.entries()).map(
    ([orderId, records]) => ({
      orderId,
      orderName: records[0].orderName,
      customerName: records[0].customerName,
      customerEmail: records[0].customerEmail,
      giftCards: records.map((r) => ({
        id: r.id,
        giftCardCode: r.giftCardCode,
        value: Number(r.value),
        currentBalance: balanceMap.get(r.giftCardId) ?? Number(r.value),
        giftCardId: r.giftCardId,
        printedAt: r.printedAt?.toISOString() || null,
        createdAt: r.createdAt,
      })),
      totalValue: records.reduce((sum, r) => sum + Number(r.value), 0),
      createdAt: records[0].createdAt,
    }),
  );

  // Paginate the orders
  const startIndex = (page - 1) * ORDERS_PER_PAGE;
  const orders = allOrders.slice(startIndex, startIndex + ORDERS_PER_PAGE);

  return {
    orders,
    currencyCode,
    currentPage: page,
    totalPages,
    totalOrders,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "markPrinted") {
    const giftCardRecordId = formData.get("giftCardRecordId") as string;

    await db.giftCardRecord.update({
      where: {
        id: giftCardRecordId,
        shop: session.shop,
      },
      data: {
        printedAt: new Date(),
      },
    });

    return { success: true, action: "markPrinted" };
  }

  if (intent === "unmarkPrinted") {
    const giftCardRecordId = formData.get("giftCardRecordId") as string;

    await db.giftCardRecord.update({
      where: {
        id: giftCardRecordId,
        shop: session.shop,
      },
      data: {
        printedAt: null,
      },
    });

    return { success: true, action: "unmarkPrinted" };
  }

  return { success: false };
};

export default function OrdersPage() {
  const { orders, currencyCode, currentPage, totalPages, totalOrders } =
    useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const goToPage = (page: number) => {
    setSearchParams({ page: page.toString() });
  };

  const handleCopyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    shopify.toast.show("Code copied to clipboard");
  };

  const handleTogglePrinted = (giftCardRecordId: string, isPrinted: boolean) => {
    fetcher.submit(
      {
        intent: isPrinted ? "unmarkPrinted" : "markPrinted",
        giftCardRecordId,
      },
      { method: "POST" },
    );
  };

  const getGiftCardStatus = (gc: GiftCardInfo) => {
    const isRedeemed = gc.currentBalance < gc.value;
    const isFullyRedeemed = gc.currentBalance === 0;
    const isPrinted = !!gc.printedAt;

    return { isRedeemed, isFullyRedeemed, isPrinted };
  };

  const handleViewOrder = (orderId: string) => {
    // Extract numeric ID from GID (gid://shopify/Order/123 -> 123)
    const numericId = orderId.split("/").pop();
    // Navigate to the order in Shopify admin
    window.open(`shopify://admin/orders/${numericId}`, "_top");
  };

  const formatDate = (date: Date | string) => {
    return new Date(date).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const formatGiftCardCode = (code: string) => {
    return (code.match(/.{1,4}/g)?.join(" ") || code).toUpperCase();
  };

  return (
    <s-page heading="Orders with Gift Cards">
      <s-section heading="Recent Orders">
        <s-paragraph>
          View orders that have generated gift cards. Click on a code to copy it
          for printing physical gift cards.
        </s-paragraph>

        {orders.length === 0 ? (
          <s-box padding="large">
            <s-stack direction="block" gap="base" alignItems="center">
              <s-text color="subdued">No gift card orders yet</s-text>
              <s-paragraph color="subdued">
                Orders containing physical gift card products will appear here
                after they are paid.
              </s-paragraph>
              <s-button href="/app/settings">
                Configure Gift Card Products
              </s-button>
            </s-stack>
          </s-box>
        ) : (
          <s-stack direction="block" gap="large">
            <s-stack
              direction="inline"
              gap="base"
              alignItems="center"
              justifyContent="space-between"
            >
              <s-text color="subdued">
                Showing {(currentPage - 1) * ORDERS_PER_PAGE + 1}-
                {Math.min(currentPage * ORDERS_PER_PAGE, totalOrders)} of{" "}
                {totalOrders} orders
              </s-text>
              {totalPages > 1 && (
                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-button
                    variant="tertiary"
                    disabled={currentPage <= 1}
                    onClick={() => goToPage(currentPage - 1)}
                  >
                    Previous
                  </s-button>
                  <s-text>
                    Page {currentPage} of {totalPages}
                  </s-text>
                  <s-button
                    variant="tertiary"
                    disabled={currentPage >= totalPages}
                    onClick={() => goToPage(currentPage + 1)}
                  >
                    Next
                  </s-button>
                </s-stack>
              )}
            </s-stack>
            {orders.map((order) => (
              <s-box
                key={order.orderId}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="block" gap="base">
                  <s-stack
                    direction="inline"
                    gap="base"
                    alignItems="center"
                    justifyContent="space-between"
                  >
                    <s-stack direction="block" gap="small-200">
                      <s-text type="strong">{order.orderName}</s-text>
                      {(order.customerName || order.customerEmail) && (
                        <s-text color="subdued">
                          {order.customerName || order.customerEmail}
                        </s-text>
                      )}
                      <s-text color="subdued">
                        {formatDate(order.createdAt)}
                      </s-text>
                    </s-stack>
                    <s-stack direction="inline" gap="base" alignItems="center">
                      <s-badge>
                        {order.giftCards.length} gift card
                        {order.giftCards.length !== 1 ? "s" : ""}
                      </s-badge>
                      <s-text type="strong">
                        {formatCurrency(order.totalValue, currencyCode)} total
                      </s-text>
                      <s-button
                        variant="tertiary"
                        onClick={() => handleViewOrder(order.orderId)}
                      >
                        View Order
                      </s-button>
                    </s-stack>
                  </s-stack>

                  <s-divider />

                  <s-stack direction="block" gap="small">
                    <s-text type="strong">Gift Card Codes:</s-text>
                    {order.giftCards.map((gc, index) => {
                      const { isRedeemed, isFullyRedeemed, isPrinted } =
                        getGiftCardStatus(gc);
                      const isDisabled = isFullyRedeemed || isPrinted || isRedeemed;

                      return (
                        <s-box
                          key={gc.id}
                          padding="small"
                          background="subdued"
                          borderRadius="base"
                        >
                          <s-stack direction="block" gap="small">
                            <s-stack
                              direction="inline"
                              gap="base"
                              alignItems="center"
                              inlineSize="100%"
                            >
                              <s-text color="subdued">#{index + 1}</s-text>
                              <s-box
                                padding="small"
                                background={isDisabled ? "subdued" : "base"}
                                borderRadius="base"
                                borderWidth="base"
                                inlineSize="100%"
                              >
                                <s-text
                                  type="strong"
                                  color={isDisabled ? "subdued" : "base"}
                                >
                                  {formatGiftCardCode(gc.giftCardCode)}
                                </s-text>
                              </s-box>
                              <s-text color={isDisabled ? "subdued" : "base"}>
                                {formatCurrency(gc.value, currencyCode)}
                              </s-text>
                              {!isDisabled && (
                                <s-button
                                  variant="tertiary"
                                  onClick={() => handleCopyCode(gc.giftCardCode)}
                                >
                                  Copy
                                </s-button>
                              )}
                              {!isRedeemed && (
                                <s-button
                                  variant="tertiary"
                                  onClick={() => handleTogglePrinted(gc.id, isPrinted)}
                                >
                                  {isPrinted ? "Unmark" : "Mark Printed"}
                                </s-button>
                              )}
                            </s-stack>
                            <s-stack direction="inline" gap="small">
                              {isPrinted && (
                                <s-badge tone="success">Printed</s-badge>
                              )}
                              {isFullyRedeemed && (
                                <s-badge tone="info">Fully Redeemed</s-badge>
                              )}
                              {isRedeemed && !isFullyRedeemed && (
                                <s-badge tone="warning">
                                  Partially Used ({formatCurrency(gc.currentBalance, currencyCode)} remaining)
                                </s-badge>
                              )}
                            </s-stack>
                          </s-stack>
                        </s-box>
                      );
                    })}
                  </s-stack>
                </s-stack>
              </s-box>
            ))}
            {totalPages > 1 && (
              <s-stack
                direction="inline"
                gap="small"
                alignItems="center"
                justifyContent="center"
              >
                <s-button
                  variant="tertiary"
                  disabled={currentPage <= 1}
                  onClick={() => goToPage(currentPage - 1)}
                >
                  Previous
                </s-button>
                <s-text>
                  Page {currentPage} of {totalPages}
                </s-text>
                <s-button
                  variant="tertiary"
                  disabled={currentPage >= totalPages}
                  onClick={() => goToPage(currentPage + 1)}
                >
                  Next
                </s-button>
              </s-stack>
            )}
          </s-stack>
        )}
      </s-section>

      <s-section slot="aside" heading="About Gift Card Codes">
        <s-paragraph>
          Gift card codes are generated automatically when orders containing
          designated gift card products are paid.
        </s-paragraph>
        <s-paragraph>
          Each code can be printed on a physical gift card and given to the
          customer. The code can be redeemed at checkout.
        </s-paragraph>
        <s-paragraph>
          <s-text type="strong">Security Note:</s-text> Gift card codes should
          be treated like cash. Only share codes with intended recipients.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
