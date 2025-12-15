/*
  Warnings:

  - Added the required column `variantId` to the `GiftCardProduct` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_GiftCardProduct" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_GiftCardProduct" ("createdAt", "id", "productId", "shop", "updatedAt") SELECT "createdAt", "id", "productId", "shop", "updatedAt" FROM "GiftCardProduct";
DROP TABLE "GiftCardProduct";
ALTER TABLE "new_GiftCardProduct" RENAME TO "GiftCardProduct";
CREATE INDEX "GiftCardProduct_shop_idx" ON "GiftCardProduct"("shop");
CREATE INDEX "GiftCardProduct_shop_productId_idx" ON "GiftCardProduct"("shop", "productId");
CREATE UNIQUE INDEX "GiftCardProduct_shop_variantId_key" ON "GiftCardProduct"("shop", "variantId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
