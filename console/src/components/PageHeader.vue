<script setup lang="ts">
interface IProps {
  title: string
  description?: string
}

defineProps<IProps>()
</script>

<template>
  <div class="flex items-start justify-between">
    <div>
      <h1 class="text-2xl font-semibold text-neutral-900">{{ title }}</h1>
      <p v-if="description" class="mt-1 text-sm text-neutral-500">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="flex items-center gap-2">
      <slot name="actions" />
    </div>
  </div>
</template>
