<script setup lang="ts">
interface IProps {
  label: string
  value: number | string
  icon: string
  accentBg: string
  accentText: string
}

defineProps<IProps>()
</script>

<template>
  <div class="flex items-center gap-4 rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
    <div
      class="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg"
      :class="[accentBg, accentText]"
    >
      <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path :d="icon" />
      </svg>
    </div>
    <div>
      <div class="text-sm font-medium text-neutral-500">{{ label }}</div>
      <div class="mt-0.5 font-mono text-2xl font-semibold text-neutral-900">{{ value }}</div>
    </div>
  </div>
</template>
