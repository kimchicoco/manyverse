/**
 * MMMMM is a mobile app for Secure Scuttlebutt networks
 *
 * Copyright (C) 2017 Andre 'Staltz' Medeiros
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

import xs, {Stream} from 'xstream';
import flattenConcurrently from 'xstream/extra/flattenConcurrently';
import {isMsg, Msg, PeerMetadata, Content} from '../ssb/types';
import aboutSyncOpinion from '../ssb/opinions/about/sync';
import configOpinion from '../ssb/opinions/config';
import makeKeysOpinion from '../ssb/opinions/keys';
import metadataOpinion from '../ssb/opinions/metadata';
import xsFromPullStream from '../to-publish/xs-from-pull-stream';
import xsFromMutant from '../to-publish/xs-from-mutant';
const blobUrlOpinion = require('patchcore/blob/sync/url');
const sbotOpinion = require('patchcore/sbot');
const backlinksOpinion = require('patchcore/backlinks/obs');
const aboutOpinion = require('patchcore/about/obs');
const unboxOpinion = require('patchcore/message/sync/unbox');
const msgLikesOpinion = require('patchcore/message/obs/likes');
const ssbClient = require('react-native-ssb-client');
const depjectCombine = require('depject');
const Config = require('ssb-config/inject');
const nest = require('depnest');

const emptyHookOpinion = {
  gives: nest('sbot.hook.publish'),
  create: (api: any) => {
    return nest('sbot.hook.publish', () => {});
  }
};

function isNotSync(msg: any): boolean {
  return !msg.sync;
}

export type SSBSource = {
  feed: Stream<any>;
  connectedPeers: Stream<Array<PeerMetadata>>;
};

function addDerivedDataToMessage(msg: Msg, api: any): Stream<Msg> {
  if (isMsg(msg)) {
    const likes$ = xsFromMutant(api.message.obs.likes[0](msg.key));
    const name$ = xsFromMutant(api.about.obs.name[0](msg.value.author));
    return xs
      .combine(likes$, name$)
      .map(([likes, name]: [Array<string>, string]) => {
        if (msg.value) {
          msg.value._derived = msg.value._derived || {};
          msg.value._derived.likes = likes;
          msg.value._derived.ilike = likes.some(
            key => key === api.keys.sync.id[0]()
          );
          msg.value._derived.about = {name};
        }
        return msg;
      });
  } else {
    return xs.of(msg);
  }
}

export function ssbDriver(sink: Stream<Content>): SSBSource {
  const keys$ = xs.fromPromise(ssbClient.fetchKeys(Config('ssb')));

  const api$ = keys$.map(keys => {
    return depjectCombine([
      emptyHookOpinion,
      blobUrlOpinion,
      aboutSyncOpinion,
      configOpinion,
      makeKeysOpinion(keys),
      sbotOpinion,
      metadataOpinion,
      backlinksOpinion,
      aboutOpinion,
      unboxOpinion,
      msgLikesOpinion
    ]);
  });

  const feed$ = api$
    .take(1)
    .map(api =>
      xsFromPullStream<any>(
        api.sbot.pull.feed[0]({reverse: false, limit: 100, live: true})
      )
        .map(msg => addDerivedDataToMessage(msg, api))
        .compose(flattenConcurrently)
    )
    .flatten()
    .filter(isNotSync);

  const connectedPeers$ = api$
    .map(api => xsFromMutant<any>(api.sbot.obs.connectedPeers[1]()))
    .flatten();

  api$
    .map(api => sink.map(newContent => [api, newContent]))
    .flatten()
    .addListener({
      next: ([api, newContent]) => {
        api.sbot.async.publish[0](newContent);
      }
    });

  return {
    feed: feed$,
    connectedPeers: connectedPeers$
  };
}
