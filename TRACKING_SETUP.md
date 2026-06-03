# KillaWork Tracking Setup

KillaWork loads Google Tag Manager once on product pages. GA4 and Microsoft Clarity should be configured inside GTM instead of being added as separate website scripts.

KillaWork also loads the Google Ads base tag directly for `AW-18188860218` on product pages so Google Ads can detect the sign-up conversion action. The conversion hit itself is still fired only after Firebase confirms a new account.

Generated customer portfolio sites are intentionally excluded from KillaWork product analytics.

## Railway Variable

Add this shared variable to the Railway project:

```text
GTM_CONTAINER_ID=GTM-NDCKPZ6Z
```

The app defaults to `GTM-NDCKPZ6Z`, but keeping this Railway variable set makes the container explicit and easy to replace later.

## Base Tags In GTM

Create and publish these tags:

1. **Google tag / GA4 configuration tag**
   - Add the GA4 Measurement ID.
   - Trigger: `Initialization - All Pages`.

2. **Google Ads Conversion Linker**
   - Trigger: `All Pages`.

3. **Microsoft Clarity**
   - Use the Microsoft Clarity GTM template or a Custom HTML tag containing the Clarity snippet.
   - Clarity project ID: `x0t08kbqi9`.
   - Trigger: `All Pages`.

## Custom Event Triggers

Create a GTM Custom Event trigger for each event:

```text
hero_cta_click
secondary_cta_click
signup_start
signup_complete
upload_start
upload_success
template_selected
checkout_start
pricing_view
subscription_purchase
```

## GA4 Event Tags

Send these events to GA4 using GA4 Event tags connected to their matching Custom Event triggers:

```text
hero_cta_click
signup_start
signup_complete
upload_start
upload_success
template_selected
checkout_start
pricing_view
subscription_purchase
```

Create GTM Data Layer Variables for event parameters you want to send, such as:

```text
cta_text
page_path
location
source_section
method
file_count
upload_type
template_id
plan_name
price
value
currency
transaction_id
```

## Google Ads Conversion Tags

The confirmed sign-up conversion is fired directly by `public/tracking.js` when Firebase confirms a new account.

Direct sign-up conversion:

```text
Conversion ID: AW-18188860218
Conversion Label: h929CMCvj7gcELr2j-FD
Value: 1.0
Currency: AED
Trigger in code: signup_complete
```

Do not also create a Google Ads conversion tag in GTM for `signup_complete`, or sign-ups may be counted twice.

Create Google Ads conversion tags in GTM for the remaining funnel events and connect them to matching Custom Event triggers.

Recommended funnel conversions:

| Priority | Event |
| --- | --- |
| Primary/Secondary, direct code conversion | `signup_complete` |
| Primary | `upload_success` |
| Primary | `checkout_start` |
| Secondary | `hero_cta_click` |
| Secondary | `upload_start` |
| Secondary | `pricing_view` |

For the confirmed Stripe subscription purchase:

1. Create a Google Ads Conversion Tracking tag.
2. Conversion ID: `AW-18188860218`.
3. Conversion Label: `Zp-LCJf73rYcELr2j-FD`.
4. Trigger: Custom Event `subscription_purchase`.
5. Set **Transaction ID** to the Data Layer Variable `transaction_id`.
6. Set **Conversion Value** to the Data Layer Variable `value`.
7. Set **Currency Code** to the Data Layer Variable `currency`.

KillaWork pushes `subscription_purchase` only after Stripe confirms the subscription and deduplicates it in the browser using the Stripe Checkout session ID.

## Privacy

The tracking helper accepts behavior metadata only. Do not add passwords, uploaded file content, credit-card details, names, email addresses, phone numbers, URLs entered by users, file names, or private text fields to the data layer.

Private builder, manager, and editor surfaces are marked with `data-clarity-mask="true"` so Clarity session recordings mask portfolio details, prompts, URLs, and uploaded-work metadata.

## Testing

1. Add `GTM_CONTAINER_ID` to Railway and redeploy.
2. Open GTM Preview Mode.
3. Click the homepage import CTA.
4. Click a secondary CTA.
5. Open Google sign-in and complete a new signup.
6. Start and complete a file upload.
7. Select a ZIP builder template.
8. Scroll until the pricing section is visible.
9. Start Stripe checkout.
10. Complete a Stripe test subscription and return to Manage Projects.
11. Confirm the events appear in GTM Preview.
12. Confirm GA4 events appear in GA4 DebugView.
13. Confirm Google Ads conversion status after testing.
14. Confirm Clarity receives a session.

This project does not use AMP pages, so no AMP tracking snippet is required.
