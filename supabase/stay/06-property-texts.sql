-- ─────────────────────────────────────────────────────────────────────────────
-- StayLog — phase 4: Raaya Vasyam's guest texts become property data.
-- After 05-migrate.sql (and the switch). Safe to run twice: it only fills a
-- field that is still empty, so nothing typed in the app is overwritten.
--
-- Until v63 these texts were written in the app's code. They move, word for
-- word, into the properties of the account moved in from the old model (your
-- account): the six house rules (the confirmation PDF), the house notes (the
-- house notes PDF, with the utensil sentence), and the welcome lines of the
-- "Welcome & house info" message, ending "Enjoy Udupi". Check-in 1:00 PM and
-- check-out 11:00 AM are already each property's own times (the columns'
-- defaults). From v63 the app reads all of them from the property, and a new
-- property starts from neutral wording instead. They are guest-facing texts,
-- already public in this repository's history; nothing private is here.
-- ─────────────────────────────────────────────────────────────────────────────
with mine as (
  select p.account_id, p.id from stay.properties p join stay.accounts a on a.id = p.account_id
  where a.migrated_from is not null and p.deleted_at is null
    and coalesce((p.legacy ->> 'placeholder')::boolean, false) = false
)
update stay.properties p set house_rules = array[
  $rv$Home by 10 PM
Ours is a quiet neighbourhood and the evenings here are wonderfully serene. We kindly ask that everyone is back at the house by 10 PM. It keeps us on good terms with our neighbours and gives you the restful night you deserve after a day of exploring.$rv$,
  $rv$A home, not a party venue
This house is meant as a calm, intimate retreat. Please keep gatherings to your own group and avoid large get-togethers or loud events. Good conversation and laughter are always welcome — just keep it cosy.$rv$,
  $rv$A smoke-free home
The entire property, indoors and outdoors, is strictly non-smoking. If you do need a smoke, we kindly ask that you step outside the property gates. Thank you for understanding.$rv$,
  $rv$Switch off when you step out
When you head out, please turn off the lights, fans and air conditioners. A small habit that makes a real difference — to the environment and to keeping things running smoothly.$rv$,
  $rv$A clean kitchen is a happy kitchen
The kitchen is yours to use and enjoy. We only ask that utensils, pots, pans and dishes are washed and put back after use, so the space stays ready for your next meal.$rv$,
  $rv$Shoes off at the door
We follow the lovely tradition of leaving footwear outside the entrance. There is a dedicated spot for shoes right at the door — step in and feel at home.$rv$
]
from mine where p.account_id = mine.account_id and p.id = mine.id and coalesce(array_length(p.house_rules, 1), 0) = 0;

with mine as (
  select p.account_id, p.id from stay.properties p join stay.accounts a on a.id = p.account_id
  where a.migrated_from is not null and p.deleted_at is null
    and coalesce((p.legacy ->> 'placeholder')::boolean, false) = false
)
update stay.properties p set house_notes = $rv$Hot Water
We rely on solar heating, so on sunny days you’ll have hot water in all bathrooms. As a backup, geysers are installed in the living room bathroom and the 1st floor bedroom bathroom. Their switches (marked 16A) are located just outside the respective bedrooms — please switch them on about 20–30 minutes before use if the solar water isn’t warm enough.

Water Supply
If the water flow stops, it likely means the overhead tank has run dry. Simply switch on the motor, located above the washing machine in the kitchen area. If water still doesn’t resume, please also check the corresponding switch on the MCB board.

Vessels & Utensils
As mentioned in the house rules, please clean vessels after use. If you’d prefer, our househelp can do this for you at a nominal charge of Rs. 100, payable directly to her.

Housekeeping
Our househelp comes daily to clean the house. Please let us know your convenient time — we’d suggest either 7:30–8:00 AM or after 2:00 PM.

Main Gate
Please keep the main gate closed, especially through the night. It keeps the house secure and keeps stray animals out of the compound.

Footwear
Please leave shoes and chappals in the shoe rack rather than outside the door — stray dogs in the area are known to carry footwear away.$rv$
from mine where p.account_id = mine.account_id and p.id = mine.id and coalesce(p.house_notes, '') = '';

with mine as (
  select p.account_id, p.id from stay.properties p join stay.accounts a on a.id = p.account_id
  where a.migrated_from is not null and p.deleted_at is null
    and coalesce((p.legacy ->> 'placeholder')::boolean, false) = false
)
update stay.properties p set welcome_text = $rv$*Kitchen:* yours to use — we only ask that everything is washed and put back after each use.
*Stepping out:* please switch off the lights, fans and AC, and pull the door shut behind you.
*Evenings:* the neighbourhood turns in early, so do keep things quiet and plan to be back by 10 PM.
*Footwear:* there is a spot at the entrance — shoes stay outside.

The house is entirely non-smoking, indoors and out.

Anything you cannot find, just message here. Enjoy Udupi.$rv$
from mine where p.account_id = mine.account_id and p.id = mine.id and coalesce(p.welcome_text, '') = '';

select p.name as "property",
       coalesce(array_length(p.house_rules, 1), 0) || ' house rules' as "rules",
       case when coalesce(p.house_notes, '') <> '' then 'house notes set' else 'NO house notes' end as "notes",
       case when coalesce(p.welcome_text, '') <> '' then 'welcome text set' else 'NO welcome text' end as "welcome",
       to_char(p.checkin_time, 'FMHH12:MI AM') || ' / ' || to_char(p.checkout_time, 'FMHH12:MI AM') as "times"
from stay.properties p join stay.accounts a on a.id = p.account_id
where a.migrated_from is not null and p.deleted_at is null;
