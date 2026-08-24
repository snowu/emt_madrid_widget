# BiciMAD account API research

Recorded 2026-08-23 from the public Android app package
`com.emtmadrid.bicimad.gestion2` version 5.8.8. This is static analysis of the
published client plus unauthenticated `GET` checks. No authenticated account was
used and no write operation was invoked.

## Important correction

The current app's account features do **not** use PBSC's
`madrid.publicbikesystem.net/customer/*` API. PBSC serves station data and has an
operator application, but BiciMAD account state is handled by EMT's MPass and
EMTPay services:

- `https://api.mpass.mobi/` — identity and wallet
- `https://apiemtpay.emtmadrid.es/` — BiciMAD user, trips and billing
- `https://openapi.emtmadrid.es/` — public transport data and app access tokens

The app requires a normally authenticated MPass session. An `accessToken` alone
is not always enough: requests also carry the MPass user id and device/app
metadata. Trip history additionally carries the BiciMAD NIF and legacy session
identifier.

## Read entry points relevant to account health

### Account snapshot

```http
GET https://apiemtpay.emtmadrid.es/v2/bicimad/userdata/
```

The app also contains v3 and v4 variants. The BiciMAD screen currently calls v2;
the contactless-card SDK contains v3/v4. An unauthenticated request to all three
returns HTTP 401 with EMT code `80`, confirming that they are live and guarded.

Headers used by the app include:

```text
accessToken, userId, deviceId, email,
latitude, longitude, deviceModel,
appPlatform, appPlatformVersion, appVersion, appName, language
```

Useful response fields discovered in the app model:

- `NM_STATE` — numeric BiciMAD user state. Do not label its values until they
  have been observed from real accounts; the app only proves that `-1` means
  absent/unknown and treats `1` specially during migration.
- `IT_STATUS` — boolean user status.
- `DS_BALANCE` — current BiciMAD balance.
- `dataContract[]`:
  - `IT_ACTIVE`, `IT_STATUS`, `IT_AUTORENEW`
  - `DT_CREATED`, `DT_INITPERIOD`, `DT_ENDPERIOD`, `DT_EXPIRED`
  - `DS_CODE`, `DS_NAME`
  - `mediaaccess[]`

The MPass SDK defines media-access states as `INACTIVO=1`, `ACTIVO=2`,
`BLOQUEADO=3`, `PENDIENTE=4`, and `SIN_USUARIO=5`. These describe an access
medium; they must not automatically be presented as the whole BiciMAD account
state.

### Trip history, penalties and unusual charges

```http
GET https://apiemtpay.emtmadrid.es/v2/bicimad/trips/
```

Headers are the account headers above plus:

```text
nif, session, mode: mPass, page (optional)
```

No date, cursor, or `since` header/parameter is present in the published app's
request mapping. Incremental consumers must page until they overlap a retained
`trip_id`; they cannot ask EMTPay to filter server-side by date.

Each trip can contain:

- `trip_id`, `id_bike`, `undock`, `dock`, `trip_interval`, `trip_minutes`
- `old_amount`, `new_amount`, `trip_cost`
- `dock_bono`, `undock_bono`, `reserve_bono`
- `penalty.penalty`
- `penalty.penalty_amount`
- `penalty.penalty_ts` (a map of penalty timestamps)
- `extrainfo.amount`, `extrainfo.date`, localized title/description

This is the best discovered source for strikes/penalties and outlying charges.
A tracker should retain the raw values and flag:

1. nonzero penalty count or amount;
2. negative/large balance deltas (`new_amount - old_amount`);
3. a delta that does not reconcile with `trip_cost` and bonuses;
4. unusually long rides or repeated charges for one `trip_id`;
5. non-trip `extrainfo` charges.

The response model does not expose a single global `strikes` field. Strikes may
need to be derived from trip penalties unless a real account response reveals
an additional field ignored by the Android model.

### MPass identity and wallet

```http
GET https://api.mpass.mobi/v1/core/identity/whoami
GET https://api.mpass.mobi/v3/transportcard/list/0
GET https://api.mpass.mobi/v3/transportcard/mediaaccess/{id}
GET https://apiemtpay.emtmadrid.es/v1/mPass/userdata/devices
```

These provide identity/session validation, wallet media, access-medium status,
and logged-in devices. They require the legitimate MPass token and, depending
on the endpoint, `X-ClientId`, operator id, email, or device headers.

The app logs in normally with:

```http
POST https://api.mpass.mobi/v1/core/identity/login/integrator
```

The request body contains the user's email/password plus app integrator
credentials. Those app credentials are embedded native data, not user
credentials. This project should not copy or publish them. Prefer a token
created by the official client, or an EMT-supported OAuth/integrator flow if one
is made available.

### Contracts, payment methods and debt

The MPass SDK opens authenticated first-party web views for:

- contracts and service activation;
- payment methods;
- `deuda/` (debt) and `tieneDeuda` (has debt);
- `gestionTarjeta/obtenerListaTarjetasCliente` (payment-method list);
- `validarMedioPago` (validate payment method).

These are useful leads for outstanding debt, but the published APK does not
contain a clean read-only JSON contract for all of them. Observe the official
web view's authenticated requests before implementing them. Never log complete
card records or payment tokens.

## Reservation versus “blocking a bike”

The app exposes an official **dock/base reservation**, not an arbitrary bike
lock:

```http
POST   https://apiemtpay.emtmadrid.es/v1/bicimad/booking/
DELETE https://apiemtpay.emtmadrid.es/v1/bicimad/booking/
```

The station number is sent in a header. The response and UI refer to “Dock
reservation completed”; a reservation has `station_number`, `station_name`,
`start_ts`, and `expiry_ts`. This holds a dock/base at a station. It does not
block a particular bicycle.

The public PBSC Comet operator client contains temporary bike-lock controls, but
those are authenticated fleet-operator functions. They are unrelated to a
customer reservation and are intentionally not called or integrated here.

## Safe next step

1. Capture one session from the official app on the account owner's device,
   without exporting passwords or payment details.
2. Redact tokens and PII from the capture before retaining it.
3. Run `tools/bicimad-account.mjs` with session values supplied through the
   environment. It performs GETs only.
4. Record the raw field names and state values, then add a worker route that
   returns only a minimal summary. Keep MPass credentials/tokens in Worker
   secrets, never in `web/`, localStorage, git, or logs.
