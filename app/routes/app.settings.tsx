import { useEffect, useState, useCallback } from "react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  HeadersFunction,
} from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { formatCurrency } from "../utils/currency";

interface VariantInfo {
  id: string;
  title: string;
  price: string;
}

interface ProductInfo {
  id: string;
  title: string;
  handle: string;
  variants: VariantInfo[];
}

interface ShopSettings {
  variantIds: string[];
  sendEmailNotification: boolean;
  printedOverhead: number;
}

async function getShopSettings(admin: any): Promise<ShopSettings> {
  const response = await admin.graphql(
    `#graphql
    query getShopMetafields {
      shop {
        metafield(namespace: "$app:gift_cards", key: "settings") {
          value
        }
      }
    }`
  );

  const data = await response.json();
  const settingsValue = data.data?.shop?.metafield?.value;

  if (settingsValue) {
    try {
      return JSON.parse(settingsValue);
    } catch {
      // Invalid JSON, return defaults
    }
  }

  return {
    variantIds: [],
    sendEmailNotification: true,
    printedOverhead: 0,
  };
}

async function saveShopSettings(admin: any, settings: ShopSettings): Promise<void> {
  const response = await admin.graphql(
    `#graphql
    query getShopId {
      shop {
        id
      }
    }`
  );
  const shopData = await response.json();
  const shopId = shopData.data?.shop?.id;

  await admin.graphql(
    `#graphql
    mutation saveSettings($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            ownerId: shopId,
            namespace: "$app:gift_cards",
            key: "settings",
            type: "json",
            value: JSON.stringify(settings),
          },
        ],
      },
    }
  );
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

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

  // Get settings from shop metafield
  const settings = await getShopSettings(admin);

  // Group variant IDs by product (we need to fetch product info)
  const variantIds = settings.variantIds;

  // Fetch product and variant details for display
  const products: ProductInfo[] = [];
  const productMap = new Map<string, VariantInfo[]>();

  if (variantIds.length > 0) {
    // Fetch all variants in one query
    const response = await admin.graphql(
      `#graphql
      query getVariants($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            title
            price
            product {
              id
              title
              handle
            }
          }
        }
      }`,
      { variables: { ids: variantIds } }
    );

    const data = await response.json();

    for (const node of data.data?.nodes || []) {
      if (node?.product) {
        const productId = node.product.id;
        const existing = productMap.get(productId) || [];
        existing.push({
          id: node.id,
          title: node.title,
          price: node.price,
        });
        productMap.set(productId, existing);

        // Store product info if not already
        if (!products.find((p) => p.id === productId)) {
          products.push({
            id: productId,
            title: node.product.title,
            handle: node.product.handle,
            variants: [],
          });
        }
      }
    }

    // Attach variants to products
    for (const product of products) {
      product.variants = productMap.get(product.id) || [];
    }
  }

  return {
    products,
    sendEmailNotification: settings.sendEmailNotification,
    printedOverhead: settings.printedOverhead ?? 0,
    currencyCode,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  // Get current settings
  const settings = await getShopSettings(admin);

  if (intent === "addProducts") {
    // Data structure: [{ productId, variants: [{ id }] }]
    const productsData = JSON.parse(formData.get("productsData") as string);

    // Add new variant IDs to settings
    const newVariantIds = new Set(settings.variantIds);
    for (const product of productsData) {
      for (const variant of product.variants) {
        newVariantIds.add(variant.id);
      }
    }

    settings.variantIds = Array.from(newVariantIds);
    await saveShopSettings(admin, settings);

    return { success: true, action: "addProducts" };
  }

  if (intent === "removeVariant") {
    const variantId = formData.get("variantId") as string;

    settings.variantIds = settings.variantIds.filter((id) => id !== variantId);
    await saveShopSettings(admin, settings);

    return { success: true, action: "removeVariant" };
  }

  if (intent === "removeProduct") {
    const productId = formData.get("productId") as string;
    const variantIdsToRemove = JSON.parse(formData.get("variantIds") as string) as string[];

    settings.variantIds = settings.variantIds.filter(
      (id) => !variantIdsToRemove.includes(id)
    );
    await saveShopSettings(admin, settings);

    return { success: true, action: "removeProduct" };
  }

  if (intent === "updateSettings") {
    const sendEmailNotification =
      formData.get("sendEmailNotification") === "true";

    settings.sendEmailNotification = sendEmailNotification;
    await saveShopSettings(admin, settings);

    return { success: true, action: "updateSettings" };
  }

  if (intent === "updateOverhead") {
    const printedOverhead = parseFloat(formData.get("printedOverhead") as string) || 0;

    settings.printedOverhead = Math.max(0, printedOverhead);
    await saveShopSettings(admin, settings);

    return { success: true, action: "updateOverhead" };
  }

  return { success: false };
};

export default function SettingsPage() {
  const { products, sendEmailNotification, printedOverhead, currencyCode } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [emailEnabled, setEmailEnabled] = useState(sendEmailNotification);
  const [overhead, setOverhead] = useState(printedOverhead.toString());

  const isLoading = fetcher.state !== "idle";

  const handleSelectProducts = useCallback(async () => {
    // Build selection IDs from currently selected products/variants
    const selectionIds = products.map((p) => ({
      id: p.id,
      variants: p.variants.map((v) => ({ id: v.id })),
    }));

    const selected = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      selectionIds,
      filter: {
        variants: true,
      },
    });

    if (selected && selected.length > 0) {
      // Products come back with their selected variants
      const productsData = (selected as any[]).map((product) => ({
        id: product.id,
        variants: product.variants.map((v: any) => ({ id: v.id })),
      }));

      fetcher.submit(
        {
          intent: "addProducts",
          productsData: JSON.stringify(productsData),
        },
        { method: "POST" },
      );
    }
  }, [shopify, products, fetcher]);

  const handleRemoveProduct = useCallback(
    (productId: string, variantIds: string[]) => {
      fetcher.submit(
        {
          intent: "removeProduct",
          productId,
          variantIds: JSON.stringify(variantIds),
        },
        { method: "POST" },
      );
    },
    [fetcher],
  );

  const handleRemoveVariant = useCallback(
    (variantId: string) => {
      fetcher.submit(
        {
          intent: "removeVariant",
          variantId,
        },
        { method: "POST" },
      );
    },
    [fetcher],
  );

  const handleToggleEmail = useCallback(() => {
    const newValue = !emailEnabled;
    setEmailEnabled(newValue);
    fetcher.submit(
      {
        intent: "updateSettings",
        sendEmailNotification: newValue.toString(),
      },
      { method: "POST" },
    );
  }, [emailEnabled, fetcher]);

  const handleSaveOverhead = useCallback(() => {
    fetcher.submit(
      {
        intent: "updateOverhead",
        printedOverhead: overhead,
      },
      { method: "POST" },
    );
  }, [overhead, fetcher]);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      if (fetcher.data.action === "addProducts") {
        shopify.toast.show("Products updated");
      } else if (fetcher.data.action === "removeProduct") {
        shopify.toast.show("Product removed");
      } else if (fetcher.data.action === "removeVariant") {
        shopify.toast.show("Variant removed");
      } else if (fetcher.data.action === "updateSettings") {
        shopify.toast.show("Settings saved");
      } else if (fetcher.data.action === "updateOverhead") {
        shopify.toast.show("Printed overhead saved");
      }
    }
  }, [fetcher.state, fetcher.data, shopify]);

  // Sync local state with loader data
  useEffect(() => {
    setEmailEnabled(sendEmailNotification);
  }, [sendEmailNotification]);

  useEffect(() => {
    setOverhead(printedOverhead.toString());
  }, [printedOverhead]);

  return (
    <s-page heading="Settings">
      <s-section heading="Gift Card Products">
        <s-paragraph>
          Products selected here will automatically generate gift cards when
          purchased. Each unit purchased creates one gift card with a value
          equal to the line item price.
        </s-paragraph>

        {products.length === 0 ? (
          <s-box padding="large">
            <s-stack direction="block" gap="base" alignItems="center">
              <s-text color="subdued">No products selected</s-text>
              <s-paragraph color="subdued">
                Select products that should generate gift cards when purchased.
              </s-paragraph>
              <s-button onClick={handleSelectProducts}>
                Select Products
              </s-button>
            </s-stack>
          </s-box>
        ) : (
          <s-stack direction="block" gap="base">
            {products.map((product) => (
              <s-box
                key={product.id}
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
                      <s-text type="strong">{product.title}</s-text>
                      <s-text color="subdued">{product.handle}</s-text>
                    </s-stack>
                    <s-button
                      variant="tertiary"
                      tone="critical"
                      onClick={() =>
                        handleRemoveProduct(
                          product.id,
                          product.variants.map((v) => v.id)
                        )
                      }
                      disabled={isLoading}
                    >
                      Remove All
                    </s-button>
                  </s-stack>
                  <s-stack direction="block" gap="small">
                    {product.variants.map((variant) => (
                      <s-box
                        key={variant.id}
                        padding="small"
                        background="subdued"
                        borderRadius="base"
                      >
                        <s-stack
                          direction="inline"
                          gap="base"
                          alignItems="center"
                          justifyContent="space-between"
                        >
                          <s-stack
                            direction="inline"
                            gap="base"
                            alignItems="center"
                          >
                            <s-text>{variant.title}</s-text>
                            <s-text color="subdued">
                              {formatCurrency(
                                Number(variant.price),
                                currencyCode,
                              )}
                            </s-text>
                          </s-stack>
                          <s-button
                            variant="tertiary"
                            tone="critical"
                            onClick={() => handleRemoveVariant(variant.id)}
                            disabled={isLoading}
                          >
                            Remove
                          </s-button>
                        </s-stack>
                      </s-box>
                    ))}
                  </s-stack>
                </s-stack>
              </s-box>
            ))}
            <s-button variant="secondary" onClick={handleSelectProducts}>
              Select Products
            </s-button>
          </s-stack>
        )}
      </s-section>

      <s-section heading="Email Notifications">
        <s-paragraph>
          Control whether customers receive email notifications when gift cards
          are created for their orders.
        </s-paragraph>

        <s-box padding="base">
          <s-checkbox
            checked={emailEnabled}
            onChange={handleToggleEmail}
            label="Send email notification to customers when gift card is created"
          />
        </s-box>

        <s-banner tone="info">
          When enabled, customers will receive an email with their gift card
          code(s) after their order is paid. The store admin can always view and
          print codes from the Orders page regardless of this setting.
        </s-banner>
      </s-section>

      <s-section heading="Printed Overhead">
        <s-paragraph>
          Set an amount to deduct from the line item price when creating gift
          card codes. This accounts for printing and production costs.
        </s-paragraph>

        <s-box padding="base">
          <s-stack direction="inline" gap="base" alignItems="end">
            <s-text-field
              label="Overhead amount"
              value={overhead}
              onChange={(e: any) => setOverhead(e.target.value)}
              prefix={currencyCode}
            />
            <s-button
              onClick={handleSaveOverhead}
              disabled={isLoading}
            >
              Save
            </s-button>
          </s-stack>
        </s-box>

        <s-banner tone="info">
          For example, if a customer purchases a {formatCurrency(252, currencyCode)} gift card product
          and the overhead is set to {formatCurrency(parseFloat(overhead) || 0, currencyCode)}, the
          generated gift card code will be worth{" "}
          {formatCurrency(Math.max(0, 252 - (parseFloat(overhead) || 0)), currencyCode)}.
        </s-banner>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
