import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickFromMarket, parseInfobox, senateBaseline, cleanName, wikiTitle } from '../scripts/import-candidates.js';

test('candidate picks from a market listing', () => {
  const o = (label, price, party = null) => ({ label, price, party });
  const { picked } = pickFromMarket([o('Katie Hobbs (D)', 0.94, 'D'), o('Andy Biggs (R)', 0.065, 'R'), o('Karrin Taylor Robson (R)', 0.001, 'R'), o('Other', 0.01, 'O')]);
  assert.deepEqual(picked.map((p) => [p.name, p.party]), [['Katie Hobbs', 'D'], ['Andy Biggs', 'R']]);
  const ne = pickFromMarket([o('Pete Ricketts (R)', 0.72, 'R'), o('Dan Osborn (I)', 0.27, 'O'), o('Cindy Burbank (D)', 0.003, 'D')]).picked;
  assert.deepEqual(ne.map((p) => p.name), ['Cindy Burbank', 'Pete Ricketts', 'Dan Osborn'], 'independent at 5%+ included; D nominee kept');
  const ca = pickFromMarket([o('A One (D)', 0.6, 'D'), o('B Two (D)', 0.39, 'D'), o('C Three (R)', 0.01, 'R')], { topN: 2 }).picked;
  assert.deepEqual(ca.map((p) => p.name), ['A One', 'B Two'], 'top-two can share a party');
  const { skipped } = pickFromMarket([o('Unlabeled Person', 0.4)], {});
  assert.equal(skipped[0].reason, 'no party label (5%+ in market)', 'no guessing of party');
  assert.equal(pickFromMarket([o('Republican', 0.5, 'R'), o('Democratic Party', 0.5, 'D')]).picked.length, 0, 'generic party outcomes are not people');
  assert.equal(cleanName('Byron Donalds (R) '), 'Byron Donalds');
});

test('Wikipedia infobox nominees and parties', () => {
  const wt = `{{Infobox election
| election_name = 2026 United States Senate election in Georgia
| nominee1 = [[Jon Ossoff]]
| party1 = Democratic Party (United States)
| nominee2 = [[Mike Collins (politician)|Mike Collins]]<ref>x</ref>
| party2 = [[Republican Party (United States)|Republican]]
}}`;
  assert.deepEqual(parseInfobox(wt).map((n) => [n.name, n.party]), [['Jon Ossoff', 'D'], ['Mike Collins', 'R']]);
  assert.equal(wikiTitle({ office: 'S', state: 'OH', stateName: 'Ohio' }), '2026 United States Senate special election in Ohio');
  assert.equal(wikiTitle({ office: 'G', state: 'GA', stateName: 'Georgia' }), '2026 Georgia gubernatorial election');
});

test('senate.gov baseline counts seats not up (class I, and class III except OH/FL)', () => {
  const m = (party, state, cls) => `<member><last_name>X</last_name><first_name>Y</first_name><party>${party}</party><state>${state}</state><class>${cls}</class></member>`;
  const xml = `<contact_information>${[m('D', 'GA', 'Class II'), m('R', 'GA', 'Class III'), m('R', 'OH', 'Class III'), m('R', 'OH', 'Class I'), m('I', 'VT', 'Class I'), m('D', 'NY', 'Class III')].join('')}</contact_information>`;
  const b = senateBaseline(xml);
  assert.deepEqual(b.notUp, { D: 1, R: 2, I: 1 });
  assert.equal(b.independents.length, 1);
});

test('unlabelled market names take a party from another source; placeholders and titles are cleaned', () => {
  const o = (label, price, party = null) => ({ label, price, party });
  const hints = [{ name: 'Mary Peltola', party: 'D', source: 'Wikipedia' }, { name: 'Dan Sullivan', party: 'R', source: 'Wikipedia' }];
  const { picked, skipped } = pickFromMarket([o('Mary Peltola', 0.73), o('Sen. Dan Sullivan', 0.28), o('Nobody Known', 0.06)], { topN: 4, hints });
  assert.deepEqual(picked.map((p) => [p.name, p.party, p.partySource]), [['Mary Peltola', 'D', 'Wikipedia'], ['Dan Sullivan', 'R', 'Wikipedia']]);
  assert.equal(skipped[0].name, 'Nobody Known');
  assert.equal(skipped.length, 1, 'no duplicate report lines');
  assert.equal(parseInfobox('| nominee1 = Darline Graham (replacing Lindsey Graham)\n| party1 = Republican Party (United States)')[0].name, 'Darline Graham');
});
