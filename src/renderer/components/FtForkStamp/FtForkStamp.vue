<template>
  <span class="forkStamp">
    {{ t('About.Fork stamp') }}
  </span>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
</script>

<style scoped src="./FtForkStamp.css" />
