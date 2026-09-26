<template>
  <div>
    <FtCard class="card">
      <h2>
        <FontAwesomeIcon
          :icon="['fas', 'info-circle']"
          class="headingIcon"
        />
        {{ $t("About.About") }}
      </h2>
      <section class="brand">
        <div class="logo">
          <img
            class="logoIcon"
            src="../../../../_icons/fjernsyn.svg"
            alt=""
          >
          <span class="logoName">{{ PRODUCT_NAME }}</span>
        </div>
        <div class="version">
          {{ versionNumber }} {{ $t("About.Beta") }}
        </div>
        <div
          v-if="buildStamp"
          class="buildStamp"
        >
          {{ buildStamp }}
        </div>
      </section>
      <section class="about-chunks">
        <figure
          v-for="chunk in forkChunks"
          :key="chunk.title"
          class="chunk"
        >
          <FontAwesomeIcon
            class="icon"
            :icon="chunk.icon"
          />
          <h3 class="title">
            {{ chunk.title }}
          </h3>
          <div
            v-safer-html="chunk.content"
            class="content"
          />
        </figure>
      </section>
      <section class="upstream">
        <h3 class="upstreamHeading">
          {{ $t("About.The FreeTube project") }}
        </h3>
        <p class="upstreamNote">
          {{ $t("About.Fork disclaimer") }}
        </p>
        <div class="about-chunks">
          <figure
            v-for="chunk in upstreamChunks"
            :key="chunk.title"
            class="chunk"
          >
            <FontAwesomeIcon
              class="icon"
              :icon="chunk.icon"
            />
            <h4 class="title">
              {{ chunk.title }}
            </h4>
            <div
              v-safer-html="chunk.content"
              class="content"
            />
          </figure>
        </div>
      </section>
    </FtCard>
  </div>
</template>

<script setup>
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import FtCard from '../../components/ft-card/ft-card.vue'
import { vSaferHtml } from '../../directives/vSaferHtml.js'

import { ABOUT_BITCOIN_ADDRESS } from '../../../constants'
import packageDetails from '../../../../package.json'

const { t } = useI18n()

const PRODUCT_NAME = packageDetails.productName

const versionNumber = `v${packageDetails.version}`

/**
 * Which build this is, as opposed to which version. Every build of a version is
 * otherwise indistinguishable, so there is no way to tell whether the one you
 * are running contains a given change. Baked in at build time; empty when it
 * could not be worked out, in which case nothing is shown.
 */
const buildStamp = process.env.BUILD_STAMP

/**
 * What belongs to this fork. Nothing here leads to the FreeTube team's own
 * places for help, bug reports or chat: a problem met in this fork is not
 * theirs to answer, and every link to them was an invitation to file one there.
 */
const forkChunks = computed(() => [
  {
    icon: ['fab', 'github'],
    title: t('About.Source code'),
    content: [
      '<a href="https://github.com/TomasEkeli/FreeTube" lang="en" dir="ltr">GitHub: TomasEkeli/FreeTube</a>',
      t('About.Forked from {upstreamLink}', {
        upstreamLink: '<a href="https://github.com/FreeTubeApp/FreeTube" lang="en" dir="ltr">FreeTubeApp/FreeTube</a>',
      }),
      t('About.Licensed under the {licenseLink}', {
        licenseLink: `<a href="https://www.gnu.org/licenses/agpl-3.0.en.html">${t('About.AGPLv3')}</a>`,
      }),
    ].join('<br>'),
  },
  {
    icon: ['fas', 'file-download'],
    title: t('About.Downloads'),
    content: `<a href="https://github.com/TomasEkeli/FreeTube/actions/workflows/build.yml?query=branch%3Amain">${t('About.Build runs on GitHub Actions')}</a>`,
  },
])

/**
 * What belongs to the FreeTube team, shown under a note that they have no part
 * in this fork.
 */
const upstreamChunks = computed(() => [
  {
    icon: ['fas', 'users'],
    title: t('About.Credits'),
    content: t('About.FreeTube is made possible by {creditsPageLink}', {
      creditsPageLink: `<a href="https://docs.freetubeapp.io/credits/">${t('About.these people and projects')}</a>`,
    }),
  },
  {
    icon: ['fab', 'bitcoin'],
    title: `${t('About.Donate')} - BTC`,
    content: `<a href="bitcoin:${ABOUT_BITCOIN_ADDRESS}">${ABOUT_BITCOIN_ADDRESS}</a>`
  }
])
</script>

<style scoped src="./About.css" />
