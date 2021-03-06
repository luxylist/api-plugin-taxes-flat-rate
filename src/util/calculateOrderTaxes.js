import Random from "@reactioncommerce/random";
import fetchWisherShippingAddress from "../../../orders-custom/util/fetchWisherShippingAddress.js";

const TAX_SERVICE_NAME = "custom-rates";

/**
 * @summary Gets all applicable tax definitions based on shop ID and shipping
 *   or origin address of a fulfillment group
 * @param {Object} collections Map of MongoDB collections
 * @param {Object} order The order
 * @returns {Object[]} Array of tax definition docs
 */
async function getTaxesForShop(collections, order) {
  const { Taxes } = collections;
  const { originAddress, shippingAddress, shopId } = order;

  const orArray = [];

  if (shippingAddress) {
    orArray.push({
      taxLocale: "destination",
      $or: [{
        postal: shippingAddress.postal
      }, {
        postal: "",
        region: shippingAddress.region,
        country: shippingAddress.country
      }, {
        postal: "",
        region: "",
        country: shippingAddress.country
      }, {
        postal: "",
        region: "",
        country: ""
      }]
    });
  }

  if (originAddress) {
    orArray.push({
      taxLocale: "origin",
      $or: [{
        postal: originAddress.postal
      }, {
        postal: "",
        region: originAddress.region,
        country: originAddress.country
      }, {
        postal: "",
        region: "",
        country: originAddress.country
      }, {
        postal: "",
        region: "",
        country: ""
      }]
    });
  }

  // Find all defined taxes where the shipping address is a match
  const taxDocs = await Taxes.find({
    shopId,
    $or: orArray
  }).toArray();

  // Rate is entered and stored in the database as a percent. Convert to ratio.
  // Also add a name. Someday should allow a shop operator to enter the name.
  return taxDocs.map((doc) => ({
    ...doc,
    rate: doc.rate / 100,
    name: `${doc.postal || ""} ${doc.region || ""} ${doc.country || ""}`.trim().replace(/\s\s+/g, " ")
  }));
}

/**
 * @summary Calculate and return taxes for an order
 * @param {Object} context App context
 * @param {Object} [cart] The original cart object, if CommonOrder was built from a cart
 * @param {Object} order The CommonOrder
 * @returns {Object|null} Calculated tax information, in `TaxServiceResult` schema, or `null` if can't calculate
 */
export default async function calculateOrderTaxes({ context, order }) {
  const { items, originAddress } = order;

  const shippingAddress = await fetchWisherShippingAddress(context, order.celebrityId);

  if (!shippingAddress && !originAddress) return null;

  const allTaxes = await getTaxesForShop(context.collections, { ...order, shippingAddress });

  /**
   * @param {Object} item The item
   * @returns {Object[]} applicable taxes for one item, in the `taxes` schema
   */
  function taxesForItem(item) {
    if (!item.isTaxable) return [];

    return allTaxes
      .filter((taxDef) => !taxDef.taxCode || taxDef.taxCode === item.taxCode)
      .map((taxDef) => ({
        _id: Random.id(),
        jurisdictionId: taxDef._id,
        sourcing: taxDef.taxLocale,
        tax: item.subtotal.amount * taxDef.rate,
        taxableAmount: item.subtotal.amount,
        taxName: taxDef.name,
        taxRate: taxDef.rate
      }));
  }

  // calculate line item taxes
  let totalTaxableAmount = 0;
  let totalTax = 0;
  const groupTaxes = {};
  const itemTaxes = items.map((item) => {
    const taxes = taxesForItem(item);

    // Update the group taxes list
    taxes.forEach((taxDef) => {
      const { jurisdictionId } = taxDef;
      if (groupTaxes[jurisdictionId]) {
        groupTaxes[jurisdictionId].tax += taxDef.tax;
        groupTaxes[jurisdictionId].taxableAmount += taxDef.taxableAmount;
      } else {
        groupTaxes[jurisdictionId] = {
          ...taxDef,
          _id: Random.id()
        };
      }
    });

    // The taxable amount for the item as a whole is the maximum amount that was
    // taxed by any of the found tax jurisdictions.
    const itemTaxableAmount = taxes.reduce((maxTaxableAmount, taxDef) => {
      if (taxDef.taxableAmount > maxTaxableAmount) return taxDef.taxableAmount;
      return maxTaxableAmount;
    }, 0);
    totalTaxableAmount += itemTaxableAmount;

    // The tax for the item as a whole is the sum of all applicable taxes.
    const itemTax = taxes.reduce((sum, taxDef) => sum + taxDef.tax, 0);
    totalTax += itemTax;

    return {
      itemId: item._id,
      tax: itemTax,
      taxableAmount: itemTaxableAmount,
      taxes
    };
  });

  // Eventually tax shipping as and where necessary here. Not yet implemented.

  return {
    itemTaxes,
    taxSummary: {
      calculatedAt: new Date(),
      calculatedByTaxServiceName: TAX_SERVICE_NAME,
      tax: totalTax,
      taxableAmount: totalTaxableAmount,
      taxes: Object.values(groupTaxes)
    }
  };
}
