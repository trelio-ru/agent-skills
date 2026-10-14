// Adapted from avito-shopping-mcp, MIT, commit 27857b9ee0609a4f2100e5d65baf4fdde506d18c.
// The adjacent avito-shopping-mcp-LICENSE.txt retains the original license.
import { isAllowedOutputUrl, publicUrl } from "./avito-api.mjs";
import { array, at, decimal, integer, isPresent, list, required, text } from "./json-fields.mjs";

const LISTING_TYPE = "item";
const SEARCH_IMAGE_SIZE = "636x636";
const SELLER_INFO_COMPONENT = "seller-info";
const SCORE_ENTRY = "score";
const REVIEW_ENTRY = "rating";

/**
 * Reads one page of `/web/1/js/items`.
 * @param response Parsed JSON body.
 * @param searchLocation Location the search was scoped to; names listings whose own address Avito leaves blank.
 * @returns Total result count and the listings on this page.
 */
export function parseSearchPage(response         , searchLocation          )             {
  const entries = required(list(at(response, "catalog", "items")), "catalog.items");
  return {
    totalCount: required(integer(at(response, "totalCount")), "totalCount"),
    items: entries
      .map((entry, index) => (at(entry, "type") === LISTING_TYPE ? searchItem(entry, `catalog.items[${index}]`, searchLocation) : null))
      .filter(isPresent),
  };
}

export function parseLocations(response         )             {
  return required(list(at(response, "result", "locations")), "result.locations").map((entry, index) => ({
    id: required(integer(at(entry, "id")), `result.locations[${index}].id`),
    name: required(text(at(entry, "names", "1")), `result.locations[${index}].names.1`),
  }));
}

export function parseRatingsPage(response         )              {
  const entries = required(list(at(response, "entries")), "entries");
  const score = entries.find((entry) => at(entry, "type") === SCORE_ENTRY);
  return {
    summary: score === undefined ? null : ratingSummary(at(score, "value")),
    reviews: entries.filter((entry) => at(entry, "type") === REVIEW_ENTRY).map((entry) => review(at(entry, "value"))),
    nextPage: text(at(response, "nextPage")),
  };
}

function searchItem(entry         , path        , searchLocation          )             {
  const hasPrice = at(entry, "priceDetailed", "hasValue") !== false;
  const publishedAt = integer(at(entry, "sortTimeStamp"));
  const image = text(at(array(at(entry, "images"))[0], SEARCH_IMAGE_SIZE));
  return {
    id: required(integer(at(entry, "id")), `${path}.id`),
    title: required(text(at(entry, "title")), `${path}.title`),
    price: hasPrice ? integer(at(entry, "priceDetailed", "value")) : null,
    priceText: displayText(at(entry, "priceDetailed", "fullString")),
    url: required(publicUrl(required(text(at(entry, "urlPath")), `${path}.urlPath`)), `${path}.urlPath`),
    location:
      text(at(entry, "addressDetailed", "locationName")) ??
      text(at(entry, "geo", "formattedAddress")) ??
      locationNameIfWithin(entry, searchLocation),
    // Trelio hardening: an out-of-range timestamp remains unknown instead of
    // throwing an untyped RangeError for an otherwise readable listing.
    publishedAt: publishedAt === null || !Number.isFinite(new Date(publishedAt).getTime()) ? null : new Date(publishedAt).toISOString(),
    image: image !== null && isAllowedOutputUrl(image) ? image : null,
    seller: searchSeller(entry),
  };
}

function locationNameIfWithin(entry         , searchLocation          )                {
  const locationId = integer(at(entry, "locationId"));
  return locationId === null || locationId === searchLocation.id ? searchLocation.name : null;
}

function searchSeller(entry         )                      {
  const sellerInfo = array(at(entry, "iva", "UserInfoStep")).find(
    (step) => at(step, "componentData", "component") === SELLER_INFO_COMPONENT,
  );
  const name = text(at(sellerInfo, "payload", "profile", "title"));
  if (!name) return null;
  const link = text(at(sellerInfo, "payload", "profile", "link"));
  return {
    name,
    url: link === null ? null : publicUrl(link),
    rating: decimal(at(sellerInfo, "payload", "rating", "score")) ?? decimal(at(entry, "rating", "score")),
  };
}

function displayText(value         )                {
  return text(typeof value === "string" ? value.replace(/\u00a0/g, " ") : value);
}

function ratingSummary(value         )                {
  return {
    score: decimal(at(value, "scoreFloat")) ?? decimal(at(value, "score")),
    reviewCount: integer(at(value, "reviewCount")),
    distribution: array(at(value, "ratingStat")).map(scoreCount).filter(isPresent),
  };
}

function scoreCount(value         )                    {
  const score = integer(at(value, "score"));
  const count = integer(at(value, "count"));
  return score === null || count === null ? null : { score, count };
}

function review(value         )               {
  return {
    score: integer(at(value, "score")),
    date: text(at(value, "rated")),
    role: text(at(value, "titleCaption")),
    itemTitle: text(at(value, "itemTitle")),
    stage: text(at(value, "stageTitle")),
    text: array(at(value, "textSections"))
      .map((section) => text(at(section, "text")))
      .filter(isPresent)
      .join("\n"),
    answer: text(at(value, "answer", "text")),
  };
}
